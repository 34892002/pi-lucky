import { getCACertificates } from "node:tls";

let trustedCertificates: string[] | undefined;

/** Trust public roots and OS-installed roots, including local HTTPS inspection CAs. */
export const providerFetch: typeof globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https:")) return globalThis.fetch(input, init);
    trustedCertificates ??= [...getCACertificates("default"), ...getCACertificates("system")];
    return globalThis.fetch(input, { ...init, tls: { ca: trustedCertificates } });
  },
  { preconnect: globalThis.fetch.preconnect },
);
