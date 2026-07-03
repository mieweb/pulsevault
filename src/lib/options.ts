import type { PulseVaultValidatePayload } from './magic.js';
import type { PulseVaultOnUploadComplete } from './pulsevaultTus.js';

/** Per-kind form of `PulseVaultAllowedExtensionsInput`, named once so it isn't re-declared at every use site. */
type AllowedExtensionsByKind = {
  video?: readonly string[];
  project?: readonly string[];
  captions?: readonly string[];
};

export type PulseVaultAllowedExtensionsInput = readonly string[] | AllowedExtensionsByKind;

export type PulseVaultAllowedExtensions = {
  video: readonly string[];
  project: readonly string[];
  captions: readonly string[];
};

const DEFAULT_VIDEO_EXTENSIONS: readonly string[] = ['.mp4'];
const DEFAULT_PROJECT_EXTENSIONS: readonly string[] = ['.pulse', '.zip'];
// Both formats: newer Pulse apps upload WebVTT (which can carry word-level cue
// timestamps for karaoke rendering); older ones upload SRT.
const DEFAULT_CAPTIONS_EXTENSIONS: readonly string[] = ['.srt', '.vtt'];
const EXTENSION_REGEX = /^\.[^.\s/\\]+$/;

/**
 * Normalize the consumer's `allowedExtensions` option (legacy array or per-kind
 * object) into the canonical `{ video, project, captions }` shape both
 * adapters pass down to the tus layer.
 */
export function normalizeAllowedExtensions(
  raw: PulseVaultAllowedExtensionsInput | undefined,
): PulseVaultAllowedExtensions {
  if (!raw) {
    return {
      video: DEFAULT_VIDEO_EXTENSIONS,
      project: DEFAULT_PROJECT_EXTENSIONS,
      captions: DEFAULT_CAPTIONS_EXTENSIONS,
    };
  }
  if (Array.isArray(raw)) {
    // Legacy flat array: treat as video-only, project/captions keep their defaults.
    return {
      video: (raw as readonly string[]).map((ext) => ext.toLowerCase()),
      project: DEFAULT_PROJECT_EXTENSIONS,
      captions: DEFAULT_CAPTIONS_EXTENSIONS,
    };
  }
  const byKind = raw as AllowedExtensionsByKind;
  return {
    video: (byKind.video ?? DEFAULT_VIDEO_EXTENSIONS).map((ext) => ext.toLowerCase()),
    project: (byKind.project ?? DEFAULT_PROJECT_EXTENSIONS).map((ext) => ext.toLowerCase()),
    captions: (byKind.captions ?? DEFAULT_CAPTIONS_EXTENSIONS).map((ext) => ext.toLowerCase()),
  };
}

/** Shared by the Fastify plugin's `prefix` and the core's `basePath` — same shape, different option name. */
export function validateBasePath(basePath: string, optionName: string): void {
  if (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/'))) {
    throw new TypeError(
      `\`${optionName}\` must be '' or start with '/' with no trailing slash (e.g. '/pulsevault')`,
    );
  }
}

export function validateMaxUploadSize(maxUploadSize: number): void {
  if (!(maxUploadSize > 0)) {
    throw new TypeError('`maxUploadSize` must be a positive number (use Infinity for no cap)');
  }
}

export function validateUploadUnit(uploadUnit: 'beat' | 'merged' | undefined): void {
  if (uploadUnit && uploadUnit !== 'beat' && uploadUnit !== 'merged') {
    throw new TypeError('`uploadUnit` must be "beat" or "merged"');
  }
}

export function validateAllowedExtensions(
  allowedExtensions: PulseVaultAllowedExtensionsInput | undefined,
): void {
  if (!allowedExtensions) return;
  const exts = Array.isArray(allowedExtensions)
    ? (allowedExtensions as readonly string[])
    : [
        ...((allowedExtensions as AllowedExtensionsByKind).video ?? []),
        ...((allowedExtensions as AllowedExtensionsByKind).project ?? []),
        ...((allowedExtensions as AllowedExtensionsByKind).captions ?? []),
      ];
  for (const ext of exts) {
    if (!EXTENSION_REGEX.test(ext)) {
      throw new TypeError(
        `\`allowedExtensions\` entry ${JSON.stringify(ext)} must start with '.' and contain no nested dots, slashes, or whitespace (e.g. '.mp4')`,
      );
    }
  }
}

/**
 * One-time (not per-request) warning for the now-deprecated per-kind project
 * hooks, so consumers notice the migration need instead of it being silently
 * aliased away until a future major version removes it outright.
 */
export function warnIfUsingDeprecatedProjectHooks(opts: {
  validateProjectPayload?: unknown;
  onProjectUploadComplete?: unknown;
}): void {
  if (opts.validateProjectPayload) {
    process.emitWarning(
      'pulsevault: `validateProjectPayload` is deprecated — use `validatePayload` and branch on `ctx.kind === "project"` instead. Still honored this release.',
      'DeprecationWarning',
    );
  }
  if (opts.onProjectUploadComplete) {
    process.emitWarning(
      'pulsevault: `onProjectUploadComplete` is deprecated — use `onUploadComplete` and branch on `ctx.kind === "project"` instead. Still honored this release.',
      'DeprecationWarning',
    );
  }
}

/** Compose the legacy per-kind hook (if any) with the generic hook, mapped onto the `"project"` kind only. */
export function composeValidatePayload(
  generic: PulseVaultValidatePayload | undefined,
  legacyProject: PulseVaultValidatePayload | undefined,
): PulseVaultValidatePayload | undefined {
  if (!legacyProject) return generic;
  return async (request, ctx) => {
    if (ctx.kind === 'project') {
      await legacyProject(request, ctx);
      return;
    }
    if (generic) await generic(request, ctx);
  };
}

export function composeOnUploadComplete(
  generic: PulseVaultOnUploadComplete | undefined,
  legacyProject: PulseVaultOnUploadComplete | undefined,
): PulseVaultOnUploadComplete | undefined {
  if (!legacyProject) return generic;
  return async (request, ctx) => {
    if (ctx.kind === 'project') {
      await legacyProject(request, ctx);
      return;
    }
    if (generic) await generic(request, ctx);
  };
}
