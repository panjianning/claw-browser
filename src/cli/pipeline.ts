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
    '',
    'Input shortcuts:',
    '  Any unknown --key value in `pipeline run` is treated as input field (for example: --keyword abc).',
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

function parseCliInputValue(raw: string): unknown {
  const value = String(raw || '').trim();
  if (value.length === 0) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return value;
}

function parseShorthandInputArgs(args: string[]): Record<string, unknown> {
  const knownValueFlags = new Set(['--workdir', '--input', '--input-file']);
  const knownBooleanFlags = new Set(['--wait']);
  const out: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    if (knownBooleanFlags.has(token)) continue;

    if (knownValueFlags.has(token)) {
      i += 1;
      continue;
    }

    const eqIdx = token.indexOf('=');
    if (eqIdx > 2) {
      const key = token.slice(2, eqIdx).trim();
      const val = token.slice(eqIdx + 1);
      if (key) out[key] = parseCliInputValue(val);
      continue;
    }

    const key = token.slice(2).trim();
    if (!key) continue;

    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = parseCliInputValue(next);
      i += 1;
    } else {
      out[key] = true;
    }
  }

  return out;
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

function keepOnlyFailedStepDetails(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const steps = Array.isArray(record.steps) ? (record.steps as Array<Record<string, unknown>>) : null;
  const stepLogs = record.stepLogs && typeof record.stepLogs === 'object' && !Array.isArray(record.stepLogs)
    ? (record.stepLogs as Record<string, unknown>)
    : null;

  if (!steps && !stepLogs) return value;

  const failedSteps = (steps || []).filter((step) => {
    return String(step?.status || '').trim().toLowerCase() === 'failed';
  });
  const failedIds = new Set(failedSteps.map((step) => String(step?.id || '')).filter((id) => id.length > 0));

  const failedStepLogs: Record<string, unknown> = {};
  if (stepLogs) {
    for (const [key, val] of Object.entries(stepLogs)) {
      if (failedIds.has(key)) {
        failedStepLogs[key] = val;
      }
    }
  }

  return {
    ...record,
    steps: failedSteps,
    stepLogs: failedStepLogs,
  };
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

    const shorthandInput = parseShorthandInputArgs(rest);

    const payload: Record<string, unknown> = {
      name,
      input: {
        ...input,
        ...shorthandInput,
      },
      wait,
      detail: wait ? 'full' : 'compact',
    };
    if (workDir) payload.workDir = workDir;

    const result = await executePipelineAction('run', payload, opts);
    const output = wait ? keepOnlyFailedStepDetails(readDataEnvelope(result)) : readDataEnvelope(result);
    printValue(opts.jsonMode, output);
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

  throw new Error(`Unknown pipeline subcommand: ${sub}`);
}
