import type { PulseVaultRequest } from './request.js';
import type { UploadKind } from '../storage/types.js';

/**
 * What the request does: `create` / `patch` upload (the TUS `POST`, and its `PATCH`/`HEAD`),
 * `resolve` opens an artifact (`GET /artifacts/<id>`), `delete` removes one (`DELETE
 * /artifacts/<id>` or a TUS `DELETE`), and `share` mints a read-only view link for one
 * (`POST /artifacts/<id>/view-link`, only when the host configured `issueViewLink`).
 */
export type PulseVaultAuthorizePhase = 'create' | 'patch' | 'resolve' | 'delete' | 'share';

export type PulseVaultAuthorizeContext = {
  phase: PulseVaultAuthorizePhase;
  artifactId: string;
  /** Artifact kind: `"video"`, `"project"`, `"captions"`, or `"thumbnail"`. Always present. */
  kind: UploadKind;
  /** Bearer / query-string token forwarded from the watch URL, if present. Only populated during the `"resolve"` phase. */
  token?: string;
  /**
   * The session-anchor artifact this one declared via `Upload-Metadata.relatedTo`,
   * if any. Lets `createCapabilityAuthorize` authorize an artifact against a
   * token scoped to the session it belongs to rather than its own id.
   */
  relatedTo?: string;
};

export type PulseVaultAuthorize = (
  request: PulseVaultRequest,
  ctx: PulseVaultAuthorizeContext,
) => void | Promise<void>;
