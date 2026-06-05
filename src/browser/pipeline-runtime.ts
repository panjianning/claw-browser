import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { SiteActionRequest } from './site-runtime.js';

type PipelineSource = 'local' | 'community';
type PipelineStepType = 'site' | 'browser' | 'pipeline' | 'artifact' | 'log';
type RunStatus = 'running' | 'completed' | 'failed' | 'canceled';
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
type StatusDetailLevel = 'compact' | 'full';

type PipelineInputDef = {
  required?: boolean;
  description?: string;
  default?: unknown;
};

type PipelineMeta = {
  name: string;
  description?: string;
  input?: Record<string, PipelineInputDef>;
  filePath: string;
  source: PipelineSource;
  runtime?: 'code' | 'site';
  siteAdapter?: string;
  siteDomain?: string;
  siteNavigation?: {
    required?: boolean;
    sameDomain?: boolean;
  };
  siteExample?: string;
};

type PipelineRunStepState = {
  id: string;
  type: PipelineStepType;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  artifactPath?: string;
  error?: string;
  exitCode?: number | null;
};

type PipelineRunState = {
  runId: string;
  ownerId: string;
  pipelineName: string;
  sessionId?: string;
  tabId?: string;
  callerWorkingDir: string;
  workDir: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  input: Record<string, unknown>;
  steps: PipelineRunStepState[];
  logs: string;
  stepLogs: Record<string, string>;
  stepContext: Record<string, Record<string, unknown>>;
  result?: Record<string, unknown>;
  cancelRequested: boolean;
  currentChild: ChildProcess | null;
};

type PipelineCodeContext = {
  input: Record<string, unknown>;
  workDir: string;
  log: (message: string) => void;
  browser: {
    run: (
      action: string,
      params?: {
        tabId?: string;
        params?: Record<string, unknown>;
      }
    ) => Promise<{
      action: string;
      tabId?: string;
      data?: unknown;
    }>;
  };
  site: {
    run: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  pipeline: {
    run: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  artifact: {
    write: (
      relativePath: string,
      data: unknown,
      options?: {
        format?: 'json' | 'text';
      }
    ) => Promise<string>;
    read: (
      relativePath: string,
      options?: {
        format?: 'json' | 'text';
      }
    ) => Promise<unknown>;
  };
  utils: {
    runCommand: (
      command: string,
      args?: string[],
      options?: {
        cwd?: string;
        timeoutMs?: number;
        env?: Record<string, unknown>;
      }
    ) => Promise<{
      ok: boolean;
      status: number | null;
      stdout: string;
      stderr: string;
    }>;
    resolvePath: (relativePath: string) => string;
    readText: (relativePath: string) => string;
    readJson: (relativePath: string) => unknown;
    writeText: (relativePath: string, data: string) => string;
    writeJson: (relativePath: string, data: unknown) => string;
  };
};

type CodePipelineModule = {
  default: (ctx: PipelineCodeContext) => Promise<Record<string, unknown>>;
  meta?: {
    name?: string;
    description?: string;
    input?: Record<string, PipelineInputDef>;
  };
};

type LoadedPipeline = {
  meta: PipelineMeta;
  run: (ctx: PipelineCodeContext) => Promise<Record<string, unknown>>;
};

type SiteListItem = {
  name: string;
  description?: string;
  domain?: string;
  args?: Record<string, { required?: boolean; description?: string; default?: unknown }>;
  source?: string;
  example?: string;
  filePath?: string;
  navigation?: {
    required?: boolean;
    sameDomain?: boolean;
  };
};

export type PipelineActionRequest = {
  action: string;
  workingDir?: string;
  sessionId?: string;
  args?: Record<string, unknown>;
};

type PipelineRuntimeContext = {
  acquireRunTab: (input: {
    ownerId: string;
    preferredTabId?: string;
    initialUrl?: string;
  }) => Promise<{
    tabId: string;
    created: boolean;
  }>;
  releaseRunOwner: (ownerId: string) => Promise<void>;
  executeSiteAction: (input: SiteActionRequest) => Promise<unknown>;
  executeBrowserAction: (input: {
    action: string;
    tabId?: string;
    workingDir?: string;
    sessionId?: string;
    ownerId?: string;
    params?: Record<string, unknown>;
  }) => Promise<{
    success: boolean;
    action: string;
    tabId?: string;
    data?: unknown;
    error?: string;
  }>;
};

const SITE_PIPELINE_PREFIX = 'site/';

export class PipelineRuntime {
  private readonly runs = new Map<string, PipelineRunState>();
  private readonly runPromises = new Map<string, Promise<void>>();

  constructor(private readonly context: PipelineRuntimeContext) {}

  async execute(input: PipelineActionRequest): Promise<unknown> {
    const action = String(input.action || '').trim().toLowerCase();

    if (action === 'list') {
      const query = String(input.args?.query || '').trim().toLowerCase();
      const workingDir = this.resolveWorkingDir(input.workingDir);
      return this.listPipelines(query, workingDir);
    }

    if (action === 'info') {
      const name = String(input.args?.name || '').trim();
      if (!name) throw new Error('pipeline info requires args.name');
      const workingDir = this.resolveWorkingDir(input.workingDir);
      return this.getPipelineInfo(name, workingDir);
    }

    if (action === 'run') {
      const name = String(input.args?.name || '').trim();
      if (!name) throw new Error('pipeline run requires args.name');
      const runInput =
        input.args?.input && typeof input.args.input === 'object' && !Array.isArray(input.args.input)
          ? (input.args.input as Record<string, unknown>)
          : {};
      const wait = input.args?.wait === true;
      const detail = this.resolveStatusDetail(input.args);
      const workDirInput = String(input.args?.workDir || '').trim();
      const workingDir = this.resolveWorkingDir(input.workingDir);
      return this.runPipeline(name, runInput, wait, detail, workDirInput, workingDir, input.sessionId);
    }

    if (action === 'status') {
      const detail = this.resolveStatusDetail(input.args);
      const runId = String(input.args?.runId || '').trim();
      if (!runId) {
        const limit = Number.isFinite(input.args?.limit) ? Math.max(1, Number(input.args?.limit)) : 20;
        const offset = Number.isFinite(input.args?.offset) ? Math.max(0, Number(input.args?.offset)) : 0;
        const pipelineName = String(input.args?.pipelineName || '').trim();
        const status = String(input.args?.status || '').trim();
        const runs = [...this.runs.values()]
          .filter((run) => (pipelineName ? run.pipelineName === pipelineName : true))
          .filter((run) => (status ? run.status === status : true))
          .sort((a, b) => (b.endedAt || Date.now()) - (a.endedAt || Date.now()))
          .slice(offset, offset + limit);
        return { runs: runs.map((run) => this.toRunStatus(run, detail)) };
      }
      const run = this.mustGetRun(runId);
      return this.toRunStatus(run, detail);
    }

    if (action === 'runs') {
      const detail = this.resolveStatusDetail(input.args);
      const limit = Number.isFinite(input.args?.limit) ? Math.max(1, Number(input.args?.limit)) : 50;
      const offset = Number.isFinite(input.args?.offset) ? Math.max(0, Number(input.args?.offset)) : 0;
      const pipelineName = String(input.args?.pipelineName || '').trim();
      const status = String(input.args?.status || '').trim();
      const runs = [...this.runs.values()]
        .filter((run) => (pipelineName ? run.pipelineName === pipelineName : true))
        .filter((run) => (status ? run.status === status : true))
        .sort((a, b) => (b.endedAt || Date.now()) - (a.endedAt || Date.now()))
        .slice(offset, offset + limit);
      return runs.map((run) => this.toRunStatus(run, detail));
    }

    if (action === 'logs') {
      const runId = String(input.args?.runId || '').trim();
      if (!runId) throw new Error('pipeline logs requires args.runId');
      const stepId = String(input.args?.stepId || '').trim();
      const offset = Number.isFinite(input.args?.offset) ? Math.max(0, Number(input.args?.offset)) : 0;
      const limit = Number.isFinite(input.args?.limit) ? Math.max(1, Number(input.args?.limit)) : 8000;
      const run = this.mustGetRun(runId);
      const full = stepId ? run.stepLogs[stepId] || '' : run.logs;
      return {
        runId,
        stepId: stepId || undefined,
        offset,
        limit,
        totalChars: full.length,
        chunk: full.slice(offset, offset + limit),
      };
    }

    if (action === 'cancel') {
      const detail = this.resolveStatusDetail(input.args);
      const runId = String(input.args?.runId || '').trim();
      if (!runId) throw new Error('pipeline cancel requires args.runId');
      const run = this.mustGetRun(runId);
      run.cancelRequested = true;
      if (run.currentChild && !run.currentChild.killed) {
        run.currentChild.kill();
      }
      if (run.status === 'running') {
        run.status = 'canceled';
      }
      this.appendRunLog(run, `[pipeline] cancel requested for runId=${runId}`);
      return this.toRunStatus(run, detail);
    }

    if (action === 'rerun') {
      const runId = String(input.args?.runId || '').trim();
      if (!runId) throw new Error('pipeline rerun requires args.runId');
      const source = this.mustGetRun(runId);
      const wait = input.args?.wait === true;
      const detail = this.resolveStatusDetail(input.args);
      const workDirInput = String(input.args?.workDir || '').trim();
      return this.runPipeline(
        source.pipelineName,
        source.input || {},
        wait,
        detail,
        workDirInput,
        source.callerWorkingDir || process.cwd(),
        input.sessionId
      );
    }

    throw new Error(`Unknown pipeline action: ${String(input.action || '')}`);
  }

  private resolveWorkingDir(workingDir?: string): string {
    if (typeof workingDir === 'string' && workingDir.trim()) return workingDir.trim();
    return process.cwd();
  }

  private resolveStatusDetail(args?: Record<string, unknown>): StatusDetailLevel {
    const detail = String(args?.detail || '').trim().toLowerCase();
    if (detail === 'full') return 'full';
    return 'compact';
  }

  private mustGetRun(runId: string): PipelineRunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run "${runId}" not found`);
    return run;
  }

  private toRunStatus(run: PipelineRunState, detail: StatusDetailLevel = 'compact'): Record<string, unknown> {
    const counts = {
      pending: run.steps.filter((item) => item.status === 'pending').length,
      running: run.steps.filter((item) => item.status === 'running').length,
      completed: run.steps.filter((item) => item.status === 'completed').length,
      failed: run.steps.filter((item) => item.status === 'failed').length,
      canceled: run.steps.filter((item) => item.status === 'canceled').length,
    };

    const base = {
      runId: run.runId,
      ownerId: run.ownerId,
      pipelineName: run.pipelineName,
      tabId: run.tabId,
      workDir: run.workDir,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      stepCounts: counts,
      result: run.result,
    };

    if (detail === 'full') {
      return {
        ...base,
        input: run.input,
        steps: run.steps,
        logs: run.logs,
        stepLogs: run.stepLogs,
      };
    }

    const lastStep = run.steps.length > 0 ? run.steps[run.steps.length - 1] : null;
    return {
      ...base,
      lastStep: lastStep
        ? {
            id: lastStep.id,
            type: lastStep.type,
            status: lastStep.status,
            summary: lastStep.summary,
            error: lastStep.error,
          }
        : null,
    };
  }

  private async listPipelines(query: string, workingDir: string): Promise<Array<Record<string, unknown>>> {
    const pipelines = await this.getAllPipelines(workingDir);
    return pipelines
      .filter((pipeline) => {
        if (!query) return true;
        return (
          pipeline.name.toLowerCase().includes(query) ||
          String(pipeline.description || '')
            .toLowerCase()
            .includes(query) ||
          String(pipeline.siteDomain || '')
            .toLowerCase()
            .includes(query)
        );
      })
      .map((pipeline) => ({
        name: pipeline.name,
        description: pipeline.description || '',
        source: pipeline.source,
        filePath: pipeline.filePath,
        runtime: pipeline.runtime || 'code',
        ...(pipeline.siteAdapter ? { siteAdapter: pipeline.siteAdapter } : {}),
        ...(pipeline.siteDomain ? { siteDomain: pipeline.siteDomain } : {}),
      }));
  }

  private async getPipelineInfo(name: string, workingDir: string): Promise<Record<string, unknown>> {
    const pipeline = (await this.getAllPipelines(workingDir)).find((item) => item.name === name);
    if (!pipeline) throw new Error(`pipeline "${name}" not found`);
    return {
      name: pipeline.name,
      description: pipeline.description || '',
      source: pipeline.source,
      input: pipeline.input || {},
      runtime: pipeline.runtime || 'code',
      filePath: pipeline.filePath,
      ...(pipeline.siteAdapter ? { siteAdapter: pipeline.siteAdapter } : {}),
      ...(pipeline.siteDomain ? { siteDomain: pipeline.siteDomain } : {}),
      ...(pipeline.siteNavigation ? { navigation: pipeline.siteNavigation } : {}),
      ...(pipeline.siteExample ? { example: pipeline.siteExample } : {}),
    };
  }

  private async runPipeline(
    name: string,
    input: Record<string, unknown>,
    wait: boolean,
    detail: StatusDetailLevel,
    workDirInput: string,
    workingDir: string,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    const loaded = await this.getPipelineByName(name, workingDir);
    if (!loaded) throw new Error(`pipeline "${name}" not found`);

    const mergedInput = this.resolveInput(loaded.meta, input);
    const runId = this.makeRunId();
    const workDir = this.resolveWorkDir(runId, workDirInput, workingDir);
    mkdirSync(workDir, { recursive: true });

    const run: PipelineRunState = {
      runId,
      ownerId: runId,
      pipelineName: loaded.meta.name,
      sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : undefined,
      tabId: undefined,
      callerWorkingDir: workingDir,
      workDir,
      status: 'running',
      startedAt: Date.now(),
      input: mergedInput,
      steps: [],
      logs: '',
      stepLogs: {},
      stepContext: {},
      cancelRequested: false,
      currentChild: null,
    };

    this.runs.set(runId, run);
    const preferredTabId = typeof mergedInput.tabId === 'string' ? mergedInput.tabId.trim() : '';
    const initialUrl = typeof mergedInput.entryUrl === 'string' ? mergedInput.entryUrl.trim() : '';
    const acquired = await this.context.acquireRunTab({
      ownerId: run.ownerId,
      preferredTabId: preferredTabId || undefined,
      initialUrl: initialUrl || undefined,
    });
    run.tabId = acquired.tabId;

    const promise = this.executeRun(loaded, run, workDir);
    this.runPromises.set(runId, promise);
    void promise.finally(() => {
      this.runPromises.delete(runId);
    });

    if (wait) {
      await promise;
      return this.toRunStatus(run, detail);
    }

    return {
      runId,
      status: run.status,
      pipeline: run.pipelineName,
      workDir: run.workDir,
      startedAt: run.startedAt,
    };
  }

  private async executeRun(loaded: LoadedPipeline, run: PipelineRunState, workDir: string): Promise<void> {
    try {
      this.appendRunLog(run, `[pipeline] start ${loaded.meta.name}`);
      const ctx = this.createCodePipelineContext(run, workDir);
      const result = await loaded.run(ctx);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`pipeline "${loaded.meta.name}" must return a plain object from default export`);
      }
      run.result = result;
      writeFileSync(join(workDir, 'result.json'), this.safeStringify(result), 'utf-8');

      run.status = run.cancelRequested ? 'canceled' : 'completed';
      run.endedAt = Date.now();
      this.appendRunLog(run, `[pipeline] ${run.status} runId=${run.runId}`);
    } catch (error) {
      run.endedAt = Date.now();
      run.status = run.cancelRequested ? 'canceled' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      this.appendRunLog(run, `[pipeline] ${run.status}: ${message}`);
      const runningStep = run.steps.find((step) => step.status === 'running');
      if (runningStep) {
        runningStep.status = run.cancelRequested ? 'canceled' : 'failed';
        runningStep.endedAt = Date.now();
        runningStep.error = message;
      }
    } finally {
      run.currentChild = null;
      await this.releaseOwnerBestEffort(run.ownerId);
      const statePath = join(workDir, 'run-state.json');
      writeFileSync(statePath, this.safeStringify(this.toRunStatus(run, 'full')), 'utf-8');
    }
  }

  private async releaseOwnerBestEffort(ownerId: string): Promise<void> {
    const RELEASE_TIMEOUT_MS = 1000;
    try {
      await Promise.race([
        this.context.releaseRunOwner(ownerId),
        new Promise<void>((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS)),
      ]);
    } catch {
      // Best effort cleanup should not block pipeline completion.
    }
  }

  private createCodePipelineContext(run: PipelineRunState, workDir: string): PipelineCodeContext {
    const assertActive = (): void => {
      if (run.cancelRequested) {
        throw new Error('Pipeline canceled by user');
      }
    };

    const beginStep = (type: PipelineStepType, summary: string): PipelineRunStepState => {
      const step: PipelineRunStepState = {
        id: `${type}_${run.steps.length + 1}`,
        type,
        status: 'running',
        startedAt: Date.now(),
        summary,
      };
      run.steps.push(step);
      this.appendStepLog(run, step.id, `[step:${step.id}] start ${summary}`);
      return step;
    };

    const finishStep = (
      step: PipelineRunStepState,
      status: StepStatus,
      options?: {
        summary?: string;
        artifactPath?: string;
        error?: string;
        exitCode?: number | null;
      }
    ): void => {
      step.status = status;
      step.endedAt = Date.now();
      if (options?.summary !== undefined) step.summary = options.summary;
      if (options?.artifactPath !== undefined) step.artifactPath = options.artifactPath;
      if (options?.error !== undefined) step.error = options.error;
      if (options?.exitCode !== undefined) step.exitCode = options.exitCode;
      this.appendStepLog(run, step.id, `[step:${step.id}] done status=${status}${step.summary ? `, ${step.summary}` : ''}`);
    };

    return {
      input: run.input,
      workDir,
      log: (message: string): void => {
        const step = beginStep('log', message);
        this.appendRunLog(run, message);
        finishStep(step, 'completed', { summary: message });
      },
      browser: {
        run: async (action, params) => {
          assertActive();
          const step = beginStep('browser', `${action}${params?.tabId ? ` tab=${params.tabId}` : ''}`);
          try {
            const result = await this.context.executeBrowserAction({
              action,
              tabId: params?.tabId || run.tabId,
              params: params?.params || {},
              workingDir: run.callerWorkingDir,
              sessionId: run.sessionId,
              ownerId: run.ownerId,
            });
            if (!result.success) {
              throw new Error(result.error || `browser action failed: ${action}`);
            }
            const normalizedAction = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            const normalizedData =
              normalizedAction === 'tab_list' && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
                ? ((result.data as Record<string, unknown>).tabs ?? result.data)
                : result.data;
            finishStep(step, 'completed', { summary: `ok: ${action}` });
            return {
              action,
              tabId: result.tabId,
              data: normalizedData,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finishStep(step, run.cancelRequested ? 'canceled' : 'failed', { error: message });
            throw error;
          }
        },
      },
      site: {
        run: async (name, args) => {
          assertActive();
          const step = beginStep('site', name);
          try {
            const result = await this.context.executeSiteAction({
              action: 'run',
              name,
              args,
              workingDir: run.callerWorkingDir,
              sessionId: run.sessionId,
              ownerId: run.ownerId,
              tabId: typeof args?.tabId === 'string' ? String(args.tabId) : run.tabId,
              entryUrl: typeof args?.entryUrl === 'string' ? String(args.entryUrl) : undefined,
            });
            finishStep(step, 'completed', { summary: `site: ${name}` });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finishStep(step, run.cancelRequested ? 'canceled' : 'failed', { error: message });
            throw error;
          }
        },
      },
      pipeline: {
        run: async (name, input) => {
          assertActive();
          const step = beginStep('pipeline', name);
          try {
            const loaded = await this.getPipelineByName(name, run.callerWorkingDir);
            if (!loaded) throw new Error(`pipeline "${name}" not found`);
            const subInput = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
            const mergedInput = this.resolveInput(loaded.meta, { ...run.input, ...subInput });
            // Sub-pipeline shares parent's tabId, ownerId, sessionId
            const subCtx = this.createCodePipelineContext(
              { ...run, input: mergedInput },
              workDir,
            );
            const result = await loaded.run(subCtx);
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
              throw new Error(`pipeline "${name}" must return a plain object`);
            }
            finishStep(step, 'completed', { summary: `pipeline: ${name}` });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finishStep(step, run.cancelRequested ? 'canceled' : 'failed', { error: message });
            throw error;
          }
        },
      },
      artifact: {
        write: async (relativePath, data, options) => {
          assertActive();
          const step = beginStep('artifact', `write ${relativePath}`);
          try {
            const path = this.resolveInsideWorkDir(workDir, relativePath);
            mkdirSync(dirname(path), { recursive: true });
            if (options?.format === 'text') {
              writeFileSync(path, typeof data === 'string' ? data : String(data), 'utf-8');
            } else {
              writeFileSync(path, this.safeStringify(data), 'utf-8');
            }
            finishStep(step, 'completed', { summary: `artifact written`, artifactPath: path });
            return path;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finishStep(step, run.cancelRequested ? 'canceled' : 'failed', { error: message });
            throw error;
          }
        },
        read: async (relativePath, options) => {
          assertActive();
          const step = beginStep('artifact', `read ${relativePath}`);
          try {
            const path = this.resolveInsideWorkDir(workDir, relativePath);
            const raw = readFileSync(path, 'utf-8');
            const value = options?.format === 'text' ? raw : this.parseJsonWithFallback(raw);
            finishStep(step, 'completed', { summary: `artifact read`, artifactPath: path });
            return value;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finishStep(step, run.cancelRequested ? 'canceled' : 'failed', { error: message });
            throw error;
          }
        },
      },

      utils: {
        runCommand: async (command, args, options) => {
          return this.runCommandInPipeline(run, command, args || [], options);
        },
        resolvePath: (relativePath) => this.resolveInsideWorkDir(workDir, relativePath),
        readText: (relativePath) => {
          const path = this.resolveInsideWorkDir(workDir, relativePath);
          return readFileSync(path, 'utf-8');
        },
        readJson: (relativePath) => {
          const path = this.resolveInsideWorkDir(workDir, relativePath);
          return this.parseJsonWithFallback(readFileSync(path, 'utf-8'));
        },
        writeText: (relativePath, data) => {
          const path = this.resolveInsideWorkDir(workDir, relativePath);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, data, 'utf-8');
          return path;
        },
        writeJson: (relativePath, data) => {
          const path = this.resolveInsideWorkDir(workDir, relativePath);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, this.safeStringify(data), 'utf-8');
          return path;
        },
      },

    };
  }



  private async runCommandInPipeline(
    run: PipelineRunState,
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, unknown>;
    }
  ): Promise<{ ok: boolean; status: number | null; stdout: string; stderr: string }> {
    if (run.cancelRequested) {
      throw new Error('Pipeline canceled by user');
    }

    const cwd = options?.cwd
      ? isAbsolute(options.cwd)
        ? options.cwd
        : resolve(run.workDir, options.cwd)
      : run.workDir;

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    const nodeBinCandidates = [join(cwd, 'node_modules', '.bin'), join(run.callerWorkingDir, 'node_modules', '.bin')];
    const extraPath = nodeBinCandidates.filter((entry) => existsSync(entry));
    if (extraPath.length > 0) {
      const delimiter = process.platform === 'win32' ? ';' : ':';
      env.PATH = `${extraPath.join(delimiter)}${delimiter}${env.PATH || ''}`;
    }

    if (options?.env && typeof options.env === 'object') {
      for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined || value === null) continue;
        env[key] = String(value);
      }
    }

    const timeoutMs = Number.isFinite(options?.timeoutMs) ? Math.max(1, Number(options?.timeoutMs)) : 120_000;

    return await new Promise((resolvePromise, rejectPromise) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      run.currentChild = child;

      const timer = setTimeout(() => {
        child.kill();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        run.currentChild = null;
        rejectPromise(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        run.currentChild = null;
        resolvePromise({
          ok: code === 0,
          status: code,
          stdout,
          stderr,
        });
      });
    });
  }

  private async getAllPipelines(workingDir: string): Promise<PipelineMeta[]> {
    const codePipelines = await this.scanCodePipelines(workingDir);
    const sitePipelines = await this.scanSitePipelines(workingDir);
    const byName = new Map<string, PipelineMeta>();

    for (const item of codePipelines) byName.set(item.name, item);
    for (const item of sitePipelines) byName.set(item.name, item);

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async scanCodePipelines(workingDir: string): Promise<PipelineMeta[]> {
    const roots: Array<{ dir: string; source: PipelineSource }> = [
      { dir: join(homedir(), '.claw-browser', 'pipelines', 'community'), source: 'community' },
      { dir: join(homedir(), '.claw-browser', 'pipelines', 'local'), source: 'local' },
      { dir: join(workingDir, '.claw-browser', 'pipelines'), source: 'local' },
    ];

    const byName = new Map<string, PipelineMeta>();
    for (const root of roots) {
      const items = await this.scanPipelineDir(root.dir, root.source, root.dir);
      for (const item of items) {
        byName.set(item.name, item);
      }
    }
    return [...byName.values()];
  }

  private async scanPipelineDir(
    dir: string,
    source: PipelineSource,
    sourceRoot: string
  ): Promise<PipelineMeta[]> {
    if (!existsSync(dir)) return [];
    const pipelines: PipelineMeta[] = [];

    const walk = async (currentDir: string): Promise<void> => {
      let entries: import('fs').Dirent[] = [];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue;
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.pipeline.mjs')) continue;

        const parsed = await this.parseCodePipelineMeta(fullPath, source, sourceRoot);
        if (parsed) pipelines.push(parsed);
      }
    };

    await walk(dir);
    return pipelines;
  }

  private async parseCodePipelineMeta(
    filePath: string,
    source: PipelineSource,
    sourceRoot: string
  ): Promise<PipelineMeta | null> {
    try {
      const imported = await this.importFreshModule<CodePipelineModule>(filePath);
      const rel = filePath
        .slice(sourceRoot.length)
        .replace(/^[/\\]/, '')
        .replace(/\\/g, '/');
      const defaultName = rel.replace(/\.pipeline\.mjs$/, '');
      const meta = imported.meta || {};

      return {
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : defaultName,
        description: typeof meta.description === 'string' ? meta.description : '',
        input: meta.input && typeof meta.input === 'object' ? meta.input : {},
        filePath,
        source,
        runtime: 'code',
      };
    } catch {
      return null;
    }
  }

  private async scanSitePipelines(workingDir: string): Promise<PipelineMeta[]> {
    let rawList: unknown;
    try {
      rawList = await this.context.executeSiteAction({ action: 'list', workingDir });
    } catch {
      return [];
    }

    if (!Array.isArray(rawList)) return [];

    const out: PipelineMeta[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const record = item as SiteListItem;
      const name = String(record.name || '').trim();
      if (!name) continue;
      const input: Record<string, PipelineInputDef> = {};
      for (const [key, value] of Object.entries(record.args || {})) {
        input[key] = {
          required: value?.required,
          description: value?.description,
          default: value?.default,
        };
      }
      if (record.navigation?.required) {
        input.entryUrl = {
          required: true,
          description: 'Entry URL for site adapter navigation',
        };
      }

      out.push({
        name: `${SITE_PIPELINE_PREFIX}${name}`,
        description: record.description || '',
        input,
        filePath: record.filePath || '',
        source: record.source === 'community' ? 'community' : 'local',
        runtime: 'site',
        siteAdapter: name,
        siteDomain: record.domain,
        siteNavigation: record.navigation,
        siteExample: record.example,
      });
    }

    return out;
  }

  private async getPipelineByName(name: string, workingDir: string): Promise<LoadedPipeline | null> {
    if (name.startsWith(SITE_PIPELINE_PREFIX)) {
      const adapter = name.slice(SITE_PIPELINE_PREFIX.length);
      if (!adapter) return null;

      const info = (await this.getPipelineInfo(name, workingDir)) as PipelineMeta & {
        runtime?: 'code' | 'site';
        siteAdapter?: string;
      };

      return {
        meta: {
          name,
          description: String((info as any).description || ''),
          input: (info as any).input || {},
          filePath: String((info as any).filePath || ''),
          source: ((info as any).source || 'local') as PipelineSource,
          runtime: 'site',
          siteAdapter: adapter,
          siteDomain: (info as any).siteDomain,
          siteNavigation: (info as any).navigation,
          siteExample: (info as any).example,
        },
        run: async (ctx) => {
          const result = await ctx.site.run(adapter, ctx.input);
          return { adapter, result };
        },
      };
    }

    const pipelines = await this.getAllPipelines(workingDir);
    const found = pipelines.find((item) => item.name === name && item.runtime !== 'site');
    if (!found) return null;

    const imported = await this.importFreshModule<CodePipelineModule>(found.filePath);
    if (!imported || typeof imported.default !== 'function') {
      throw new Error(`pipeline "${name}" missing default export function`);
    }

    return {
      meta: found,
      run: imported.default,
    };
  }

  private resolveInput(meta: PipelineMeta, input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(input || {}) };
    const inputDefs = meta.input || {};

    for (const [key, def] of Object.entries(inputDefs)) {
      const value = out[key];
      const missing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
      if (missing && def.default !== undefined) {
        out[key] = def.default;
      }
      const finalValue = out[key];
      const finalMissing =
        finalValue === undefined ||
        finalValue === null ||
        (typeof finalValue === 'string' && finalValue.trim() === '');
      if (def.required && finalMissing) {
        throw new Error(`Missing required input: ${key}`);
      }
    }

    return out;
  }

  private resolveWorkDir(runId: string, workDirInput: string, workingDir: string): string {
    if (workDirInput) {
      if (isAbsolute(workDirInput)) return workDirInput;
      return resolve(workingDir, workDirInput);
    }
    return join(homedir(), '.claw-browser', 'logs', "runs", runId);
  }

  private resolveInsideWorkDir(workDir: string, relativePath: string): string {
    const safeRelative = String(relativePath || '').trim();
    if (!safeRelative) {
      throw new Error('relativePath is required');
    }

    const resolved = isAbsolute(safeRelative) ? resolve(safeRelative) : resolve(workDir, safeRelative);
    const normalizedWorkDir = resolve(workDir);
    if (!(resolved === normalizedWorkDir || resolved.startsWith(`${normalizedWorkDir}/`))) {
      throw new Error(`Path escapes workDir: ${relativePath}`);
    }
    return resolved;
  }

  private appendRunLog(run: PipelineRunState, message: string): void {
    const payload = `[${new Date().toISOString()}] ${message}`;
    run.logs += `${payload}\n`;
  }

  private appendStepLog(run: PipelineRunState, stepId: string, message: string): void {
    const payload = `[${new Date().toISOString()}] ${message}`;
    run.stepLogs[stepId] = (run.stepLogs[stepId] || '') + `${payload}\n`;
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return JSON.stringify({ ok: false, error: 'Failed to serialize JSON' });
    }
  }

  private parseJsonWithFallback(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  private async importFreshModule<T>(filePath: string): Promise<T> {
    const mtimeMs = statSync(filePath).mtimeMs;
    const href = `${pathToFileURL(filePath).href}?v=${Math.floor(mtimeMs)}`;
    return (await import(href)) as T;
  }

  private makeRunId(): string {
    const time = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 10);
    return `run_${time}_${rand}`;
  }

}
