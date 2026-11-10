/**
 * Just enough multipart/form-data to read and rewrite one text field.
 *
 * The passthrough forwards form uploads (`/v1/audio/transcriptions`) byte for byte, but it still
 * has to know the `model` to pick a backend and to translate an aliased id. This reads that one
 * field and can replace its value; it never decodes, re-encodes or reorders anything else, so a
 * binary file part reaches the backend untouched.
 *
 * Every function answers `undefined` for a body it cannot make sense of. The caller then forwards
 * the body as it came, which is what happened before any of this existed.
 */

/** A routing field is an id, not a document; anything longer is not ours to interpret. */
const MAX_FIELD_BYTES = 512;

/** The boundary from a Content-Type, or undefined when it is not a form or names none. */
function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType || !/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return undefined;
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m?.[1] ?? m?.[2];
}

/** Where a text field's value sits in the body: [start, end). */
function locate(body: Buffer, contentType: string | undefined, name: string): [number, number] | undefined {
  const boundary = boundaryOf(contentType);
  if (!boundary) return undefined;
  const open = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);

  let pos = body.indexOf(open);
  while (pos >= 0) {
    const after = pos + open.length;
    // `--boundary--` closes the form.
    if (body[after] === 0x2d && body[after + 1] === 0x2d) return undefined;
    const headStart = body.indexOf("\r\n", after);
    if (headStart < 0) return undefined;
    const headEnd = body.indexOf("\r\n\r\n", headStart);
    if (headEnd < 0) return undefined;
    const start = headEnd + 4;
    const end = body.indexOf(next, start);
    if (end < 0) return undefined;

    // Part headers are ASCII in practice; latin1 keeps one byte per character either way.
    const head = body.toString("latin1", headStart, headEnd);
    const disposition = /^content-disposition:\s*form-data\s*;(.*)$/im.exec(head)?.[1] ?? "";
    const field = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
    // A part with a filename is an upload, whatever it is called.
    if (field === name && !/(?:^|;)\s*filename\*?=/i.test(disposition)) {
      return end - start <= MAX_FIELD_BYTES ? [start, end] : undefined;
    }
    // The CRLF before the next delimiter belongs to the delimiter, not the part.
    pos = end + 2;
  }
  return undefined;
}

/** The value of a text field in a multipart/form-data body, or undefined. */
export function multipartField(body: Buffer, contentType: string | undefined, name: string): string | undefined {
  const at = locate(body, contentType, name);
  return at ? body.toString("utf8", at[0], at[1]) : undefined;
}

/** The body with one text field's value replaced and every other byte kept, or undefined. */
export function replaceMultipartField(
  body: Buffer,
  contentType: string | undefined,
  name: string,
  value: string,
): Buffer | undefined {
  const at = locate(body, contentType, name);
  if (!at) return undefined;
  return Buffer.concat([body.subarray(0, at[0]), Buffer.from(value, "utf8"), body.subarray(at[1])]);
}
