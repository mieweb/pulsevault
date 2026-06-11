/**
 * RFC 7233 HTTP Range Request parser and response builder.
 *
 * Provides framework-independent utility for parsing Range headers and
 * computing appropriate response status, headers, and byte offsets.
 *
 * Supports:
 * - No Range header: full file (200 OK)
 * - Bounded ranges: bytes=0-99 (206 Partial Content)
 * - Open-ended ranges: bytes=512- (206 Partial Content from 512 to EOF)
 * - Suffix ranges: bytes=-1024 (206 Partial Content last 1024 bytes)
 * - Invalid ranges: malformed or out-of-bounds (416 Range Not Satisfiable)
 *
 * @example
 * const result = parseRangeRequest("bytes=0-99", 1000);
 * if (result.status === 206) {
 *   console.log(`Bytes ${result.start}-${result.end} of 1000`);
 *   console.log(result.headers["content-range"]); // "bytes 0-99/1000"
 * }
 */

export interface RangeParseResult {
  /**
   * HTTP status code: 200 (no range), 206 (valid range), 416 (invalid range).
   */
  status: 200 | 206 | 416;

  /**
   * Start byte offset (inclusive). Only set for 206 responses.
   */
  start?: number;

  /**
   * End byte offset (inclusive). Only set for 206 responses.
   */
  end?: number;

  /**
   * Response headers keyed by lowercase name.
   * Includes: accept-ranges (always), content-range (206/416), content-length (206).
   */
  headers: Record<string, string>;
}

/**
 * Parse an RFC 7233 Range header and compute response headers.
 *
 * @param rangeHeader - The Range header value (e.g., "bytes=0-99"), or undefined for no range.
 * @param fileSize - Total file size in bytes.
 * @returns RangeParseResult with status, start, end, and response headers.
 */
export function parseRangeRequest(
  rangeHeader: string | undefined,
  fileSize: number
): RangeParseResult {
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
  };

  // No Range header → 200 OK, full file.
  if (!rangeHeader) {
    return {
      status: 200,
      headers,
    };
  }

  // Parse the Range header. Format: "bytes=range1,range2,..." (we support only first range).
  const match = rangeHeader.match(/^bytes=(.+)$/i);
  if (!match || !match[1]) {
    // Malformed range header → 416.
    headers["content-range"] = `bytes */${fileSize}`;
    return {
      status: 416,
      headers,
    };
  }

  const rangeSpec = match[1];
  const ranges = rangeSpec.split(",").map((r) => r.trim());
  const range = ranges[0];

  if (!range) {
    // Empty range spec → 416.
    headers["content-range"] = `bytes */${fileSize}`;
    return {
      status: 416,
      headers,
    };
  }

  // Parse the single range: could be bounded (0-99), open-ended (512-), or suffix (-1024).
  if (range.startsWith("-")) {
    // Suffix range: bytes=-N (last N bytes).
    const suffixLength = parseInt(range.slice(1), 10);
    if (isNaN(suffixLength) || suffixLength <= 0) {
      headers["content-range"] = `bytes */${fileSize}`;
      return {
        status: 416,
        headers,
      };
    }

    const start = Math.max(0, fileSize - suffixLength);
    const end = fileSize - 1;

    if (start > end) {
      // Suffix range larger than file → 416.
      headers["content-range"] = `bytes */${fileSize}`;
      return {
        status: 416,
        headers,
      };
    }

    headers["content-range"] = `bytes ${start}-${end}/${fileSize}`;
    headers["content-length"] = String(end - start + 1);
    return {
      status: 206,
      start,
      end,
      headers,
    };
  }

  const dashIdx = range.indexOf("-");
  if (dashIdx === -1) {
    // No dash → malformed.
    headers["content-range"] = `bytes */${fileSize}`;
    return {
      status: 416,
      headers,
    };
  }

  const startStr = range.slice(0, dashIdx);
  const endStr = range.slice(dashIdx + 1);

  // Open-ended range: bytes=512- (from 512 to EOF).
  if (endStr === "") {
    const start = parseInt(startStr, 10);
    if (isNaN(start) || start < 0) {
      headers["content-range"] = `bytes */${fileSize}`;
      return {
        status: 416,
        headers,
      };
    }

    if (start >= fileSize) {
      // Start position beyond file → 416.
      headers["content-range"] = `bytes */${fileSize}`;
      return {
        status: 416,
        headers,
      };
    }

    const end = fileSize - 1;
    headers["content-range"] = `bytes ${start}-${end}/${fileSize}`;
    headers["content-length"] = String(end - start + 1);
    return {
      status: 206,
      start,
      end,
      headers,
    };
  }

  // Bounded range: bytes=0-99 (from 0 to 99, inclusive).
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);

  if (isNaN(start) || isNaN(end) || start < 0 || end < 0 || start > end) {
    headers["content-range"] = `bytes */${fileSize}`;
    return {
      status: 416,
      headers,
    };
  }

  if (start >= fileSize) {
    // Start position beyond file → 416.
    headers["content-range"] = `bytes */${fileSize}`;
    return {
      status: 416,
      headers,
    };
  }

  // Clamp end to file size minus 1.
  const actualEnd = Math.min(end, fileSize - 1);

  headers["content-range"] = `bytes ${start}-${actualEnd}/${fileSize}`;
  headers["content-length"] = String(actualEnd - start + 1);
  return {
    status: 206,
    start,
    end: actualEnd,
    headers,
  };
}
