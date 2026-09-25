/**
 * Read a byte stream into text, refusing to buffer more than `maxBytes`.
 *
 * This exists once because both untrusted-size producers in this project — a
 * provider HTTP response and a workspace file — need the same rule, and a
 * duplicated ceiling is how one of them silently drifts.
 *
 * The count is taken from the bytes actually received, never from a
 * `content-length` header: a lying header is exactly the case this guards
 * against. Leaving the `for await` loop closes the underlying stream, which is
 * what actually stops an oversized producer instead of merely ignoring it.
 */
export async function readBoundedUtf8(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
