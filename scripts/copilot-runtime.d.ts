declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };
declare module "npm:fast-xml-parser@5.11.2" {
  export { XMLParser, XMLValidator } from "fast-xml-parser";
}
declare module "npm:ws@8.18.3" {
  export default class WebSocket {
    constructor(url: string, options: { headers: Record<string,string> });
    on(event: string, callback: (...args: any[]) => void): void;
    send(data: string): void;
    close(): void;
  }
}
