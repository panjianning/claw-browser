import * as connection from '../connection/index.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { DaemonOptions } from '../connection/index.js';

interface PipelineCliOptions {
  session: string;
  jsonMode: boolean;
  version: string;
  daemonOptions: DaemonOptions;
  tabId?: string;
}

function genId(): string {
  const timestamp = Date.now() * 1000 + performance.now() * 1000;
  return `r${Math.floor(timestamp % 1000000)}`;
}

function isHelpFlag(value: string | undefined): boolean {
  return value === '--help' || value === '-h';
}

function printValue(jsonMode: boolean, value: unknown): void {
  if (jsonMode) {
    console.log(JSON.stringify(value));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function printPipelineHelp(jsonMode: boolean): void {
  const lines = [
    'Usage:',
    '  claw-browser pipeline list [query]',
    '  claw-browser pipeline info <name>',
    '  claw-browser pipeline run <name> [--input <json>] [--input-file <jsonPath>] [--workdir <path>] [--wait]',
    '  claw-browser pipeline status [runId] [--full] [--pipeline <name>] [--status <status>] [--limit <n>] [--offset <n>]',
    '  claw-browser pipeline logs <runId> [--step <stepId>] [--offset <n>] [--limit <n>]',
    '  claw-browser pipeline cancel <runId>',
    '  claw-browser pipeline runs [--pipeline <name>] [--status <status>] [--limit <n>] [--offset <n>] [--full]',
    '  claw-browser pipeline rerun <runId> [--wait] [--workdir <path>] [--full]',
    '  claw-browser pipeline modules [query]',
    '  claw-browser pipeline module-info <name>',
  ];

  if (jsonMode) {
    printValue(true, { success: true, usage: lines.slice(1) });
    return;
  }

  console.log(lines.join('\n'));
}

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.findIndex((item) => item === flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const parsed = Number.parseInt(args[index + 1], 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((item) => item === flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return String(args[index + 1] || '').trim();
}

function normalizeAction(value: string): string {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (key === 'module-info') return 'module_info';
  if (key === 'module_info') return 'module_info';
  return key;
}

async function executePipelineAction(
  action: string,
  args: Record<string, unknown>,
  opts: PipelineCliOptions
): Promise<unknown> {
  const send = async (): Promise<connection.Response> => {
    await connection.ensureDaemon(opts.session, opts.daemonOptions, opts.version);
    return await connection.sendCommand(
      {
        id: genId(),
        action: 'pipeline',
        pipelineAction: action,
        args,
        sessionId: opts.session,
        workingDir: process.cwd(),
      },
      opts.session
    );
  };

  let response = await send();

  // Backward compatibility: old daemon process may still be running after local rebuild.
  if (!response.success && typeof response.error === 'string' && response.error.includes('Unknown action: pipeline')) {
    await connection.forceStopDaemon(opts.session);
    response = await send();
  }

  if (!response.success) {
    throw new Error(response.error || `pipeline ${action} failed`);
  }
  return response.data;
}

function readDataEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'data')) {
    return record.data;
  }
  return value;
}

export async function runPipelineCli(args: string[], opts: PipelineCliOptions): Promise<void> {
  const sub = normalizeAction(args[0] || '');
  const rest = args.slice(1);

  if (!sub || sub === 'help' || isHelpFlag(sub)) {
    printPipelineHelp(opts.jsonMode);
    return;
  }

  if (sub === 'list') {
    const query = String(rest[0] || '').trim();
    const result = await executePipelineAction('list', query ? { query } : {}, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'info') {
    const name = String(rest[0] || '').trim();
    if (!name) throw new Error('Usage: claw-browser pipeline info <name>');
    const result = await executePipelineAction('info', { name }, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'run') {
    const name = String(rest[0] || '').trim();
    if (!name) {
      throw new Error(
        'Usage: claw-browser pipeline run <name> [--input <json>] [--input-file <jsonPath>] [--workdir <path>] [--wait]'
      );
    }

    const wait = rest.includes('--wait');
    const workDir = parseStringFlag(rest, '--workdir');
    const inputRaw = parseStringFlag(rest, '--input');
    const inputFile = parseStringFlag(rest, '--input-file');
    let input: Record<string, unknown> = {};

    if (inputFile) {
      const inputPath = resolve(process.cwd(), inputFile);
      let raw = '';
      try {
        raw = readFileSync(inputPath, 'utf-8');
      } catch (error: any) {
        throw new Error(`Failed to read --input-file: ${error?.message || String(error)}`);
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('must be a JSON object');
        }
        input = parsed as Record<string, unknown>;
      } catch (error: any) {
        throw new Error(`Invalid --input-file JSON: ${error?.message || String(error)}`);
      }
    }

    if (inputRaw) {
      try {
        const parsed = JSON.parse(inputRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('must be a JSON object');
        }
        input = { ...input, ...(parsed as Record<string, unknown>) };
      } catch (error: any) {
        throw new Error(`Invalid --input JSON: ${error?.message || String(error)}`);
      }
    }

    if (opts.tabId && !Object.prototype.hasOwnProperty.call(input, 'tabId')) {
      input.tabId = opts.tabId;
    }

    const payload: Record<string, unknown> = {
      name,
      input,
      wait,
      detail: wait ? 'full' : 'compact',
    };
    if (workDir) payload.workDir = workDir;

    const result = await executePipelineAction('run', payload, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'status') {
    const runId = String(rest[0] || '').trim();
    const full = rest.includes('--full');
    const pipelineName = parseStringFlag(rest, '--pipeline');
    const status = parseStringFlag(rest, '--status');
    const limit = parseNumberFlag(rest, '--limit');
    const offset = parseNumberFlag(rest, '--offset');

    const payload: Record<string, unknown> = {
      detail: full ? 'full' : 'compact',
    };
    if (runId && !runId.startsWith('--')) payload.runId = runId;
    if (pipelineName) payload.pipelineName = pipelineName;
    if (status) payload.status = status;
    if (limit !== undefined) payload.limit = limit;
    if (offset !== undefined) payload.offset = offset;

    const result = await executePipelineAction('status', payload, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'logs') {
    const runId = String(rest[0] || '').trim();
    if (!runId || runId.startsWith('--')) {
      throw new Error('Usage: claw-browser pipeline logs <runId> [--step <stepId>] [--offset <n>] [--limit <n>]');
    }
    const payload: Record<string, unknown> = { runId };
    const stepId = parseStringFlag(rest, '--step');
    const offset = parseNumberFlag(rest, '--offset');
    const limit = parseNumberFlag(rest, '--limit');
    if (stepId) payload.stepId = stepId;
    if (offset !== undefined) payload.offset = offset;
    if (limit !== undefined) payload.limit = limit;

    const result = await executePipelineAction('logs', payload, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'cancel') {
    const runId = String(rest[0] || '').trim();
    if (!runId) throw new Error('Usage: claw-browser pipeline cancel <runId>');
    const result = await executePipelineAction('cancel', { runId, detail: 'full' }, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'runs') {
    const full = rest.includes('--full');
    const pipelineName = parseStringFlag(rest, '--pipeline');
    const status = parseStringFlag(rest, '--status');
    const limit = parseNumberFlag(rest, '--limit');
    const offset = parseNumberFlag(rest, '--offset');

    const payload: Record<string, unknown> = {
      detail: full ? 'full' : 'compact',
    };
    if (pipelineName) payload.pipelineName = pipelineName;
    if (status) payload.status = status;
    if (limit !== undefined) payload.limit = limit;
    if (offset !== undefined) payload.offset = offset;

    const result = await executePipelineAction('runs', payload, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'rerun') {
    const runId = String(rest[0] || '').trim();
    if (!runId) throw new Error('Usage: claw-browser pipeline rerun <runId> [--wait] [--workdir <path>] [--full]');
    const wait = rest.includes('--wait');
    const full = rest.includes('--full');
    const workDir = parseStringFlag(rest, '--workdir');

    const payload: Record<string, unknown> = {
      runId,
      wait,
      detail: full || wait ? 'full' : 'compact',
    };
    if (workDir) payload.workDir = workDir;

    const result = await executePipelineAction('rerun', payload, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'modules') {
    const query = String(rest[0] || '').trim();
    const result = await executePipelineAction('modules', query ? { query } : {}, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  if (sub === 'module_info') {
    const name = String(rest[0] || '').trim();
    if (!name) throw new Error('Usage: claw-browser pipeline module-info <name>');
    const result = await executePipelineAction('module_info', { name }, opts);
    printValue(opts.jsonMode, readDataEnvelope(result));
    return;
  }

  throw new Error(`Unknown pipeline subcommand: ${sub}`);
}
