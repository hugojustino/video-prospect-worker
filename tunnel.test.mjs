import test from "node:test";
import assert from "node:assert";
import { findTunnelUrl } from "./tunnel.mjs";
test("extrai o endereço do túnel", () => {
  assert.equal(findTunnelUrl("INF |  https://abc-def-12.trycloudflare.com  |"), "https://abc-def-12.trycloudflare.com");
  assert.equal(findTunnelUrl("nada aqui"), null);
});
