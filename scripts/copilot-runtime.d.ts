declare const Deno: { env: { get(name: string): string | undefined } };
declare module "npm:ws@8.18.3" {
  export default class WebSocket {
    constructor(url: string, options: { headers: Record<string,string> });
    on(event: string, callback: (...args: any[]) => void): void;
    send(data: string): void;
    close(): void;
  }
}
