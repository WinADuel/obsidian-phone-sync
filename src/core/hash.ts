// Git identifies file contents by SHA-1 of "blob <size>\0<bytes>". Computing the
// same hash on the phone lets us compare local files with GitHub's tree without
// downloading anything.

export async function gitBlobSha(data: ArrayBuffer): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const buf = new Uint8Array(header.byteLength + data.byteLength);
  buf.set(header, 0);
  buf.set(new Uint8Array(data), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
