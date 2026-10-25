/** HTTPS for public endpoints; plaintext HTTP is limited to explicit loopback hosts. */
export function isHttpsOrLoopbackHttp(url: Pick<URL, "protocol" | "hostname">): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}
export function hasUrlUserInfo(url: URL): boolean {
  return Boolean(url.username || url.password);
}

export function hasUrlExtras(url: URL): boolean {
  return hasUrlUserInfo(url) || Boolean(url.search || url.hash);
}
