interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
