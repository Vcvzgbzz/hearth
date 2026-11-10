/**
 * Which tailnet machine is behind a socket address, as this machine's tailscaled knows it. The
 * local API answers on a socket only processes on this machine can open, so its answer is the
 * tailnet's own word on who is calling, independent of any token the caller presents.
 */
import { request } from "node:http";

/** A tailnet machine: its stable node ID, which survives renames, and what to show for it. */
export interface TailnetNode {
  id: string;
  name: string;
  login: string;
}

/** Ask who is at addr:port. Null when the address is not on the tailnet; throws when tailscaled cannot be asked. */
export type Whois = (addr: string, port: number) => Promise<TailnetNode | null>;

export function tailscaleWhois(socketPath: string, timeoutMs = 2000): Whois {
  return (addr, port) =>
    new Promise((resolve, reject) => {
      const ip = addr.replace(/^::ffff:/, "");
      const at = ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
      const req = request(
        // tailscaled checks the Host header on its local API; this is the name its own CLI sends.
        { socketPath, path: `/localapi/v0/whois?addr=${encodeURIComponent(at)}`, headers: { Host: "local-tailscaled.sock" }, timeout: timeoutMs },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            if (res.statusCode === 404) return resolve(null);
            if (res.statusCode !== 200) return reject(new Error(`tailscaled answered ${res.statusCode}`));
            try {
              const j = JSON.parse(body) as { Node?: { StableID?: unknown; Name?: unknown }; UserProfile?: { LoginName?: unknown } };
              const id = j.Node?.StableID;
              if (typeof id !== "string" || id === "") return reject(new Error("tailscaled named no node"));
              resolve({
                id,
                name: typeof j.Node?.Name === "string" ? j.Node.Name.replace(/\.$/, "") : "",
                login: typeof j.UserProfile?.LoginName === "string" ? j.UserProfile.LoginName : "",
              });
            } catch {
              reject(new Error("tailscaled answered something that is not JSON"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("tailscaled did not answer")));
      req.on("error", reject);
      req.end();
    });
}
