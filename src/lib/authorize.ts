import type { PulseVaultRequest } from './request.js';
import type { UploadKind } from '../storage/types.js';

/**
 * What the request does: `create` / `patch` upload (the TUS `POST`, and its `PATCH`/`HEAD`),
 * `resolve` opens an artifact (`GET /artifacts/<id>`, and the pulse's poster through
 * `GET /artifacts/<id>/poster`), `status` reads its state (`GET /artifacts/<id>/status`), `delete`
 * removes one (`DELETE /artifacts/<id>` or a TUS `DELETE`), and `share` mints a read-only view
 * link for one (`POST /artifacts/<id>/view-link`, only when the host configured `issueViewLink`).
 */
export type PulseVaultAuthorizePhase = 'create' | 'patch' | 'resolve' | 'status' | 'delete' | 'share';

export type PulseVaultAuthorizeContext = {
  phase: PulseVaultAuthorizePhase;
  artifactId: string;
  /** Artifact kind: `"video"`, `"project"`, `"captions"`, or `"thumbnail"`. Always present. */
  kind: UploadKind;
  /** Bearer / query-string token forwarded from the watch URL, if present. Only populated during the `"resolve"` and `"status"` phases. */
  token?: string;
  /**
   * The session-anchor artifact this one declared via `Upload-Metadata.relatedTo`,
   * if any. Lets `createCapabilityAuthorize` authorize an artifact against a
   * token scoped to the session it belongs to rather than its own id.
   */
  relatedTo?: string;
  /** The display name from `Upload-Metadata.name`, when the client sent one. */
  name?: string;
  /** The uploading app's version from `Upload-Metadata.appVersion`, when sent. */
  appVersion?: string;
  /** The original filename from `Upload-Metadata.filename`. Absent only when storage doesn't know the artifact. */
  filename?: string;
  /** Lowercase extension of `filename`, with the leading dot. */
  ext?: string;
  /**
   * The host data the capability token carried when this artifact was created (see
   * `issueCapabilityToken`'s `context`), read back from storage. Absent on `create`, where the
   * token is being verified for the first time: the hook returns it instead (below).
   */
  context?: unknown;
};

/**
 * What `authorize` may return on `create`: the opaque `context` to store with the artifact,
 * typically the claims of the capability token that authorized it. Ignored on other phases.
 */
export type PulseVaultAuthorizeResult = { context?: unknown } | void;

export type PulseVaultAuthorize = (
  request: PulseVaultRequest,
  ctx: PulseVaultAuthorizeContext,
) => PulseVaultAuthorizeResult | Promise<PulseVaultAuthorizeResult>;
