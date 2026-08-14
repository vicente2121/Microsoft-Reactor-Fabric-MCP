#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const FABRIC_MCP_URL =
  process.env.FABRIC_MCP_URL ?? "https://api.fabric.microsoft.com/v1/mcp/core";
const FABRIC_RESOURCE =
  process.env.FABRIC_RESOURCE ?? "https://api.fabric.microsoft.com";

let remoteClient;
let remoteTransport;
let cachedToken;
let tokenFetchedAt = 0;

function log(message) {
  console.error(`[fabric-mcp-proxy] ${message}`);
}

function debug(message) {
  if (process.env.FABRIC_PROXY_DEBUG === "1") {
    log(message);
  }
}

function findAzureCli() {
  const configured = process.env.FABRIC_AZ_COMMAND?.trim();
  if (configured) {
    return configured;
  }

  const candidates = [
    "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
    "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Python\\Python312\\Scripts\\az.bat`,
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Python\\Python312\\Scripts\\az`
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "az";
}

function quoteForPowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function getAzureCliToken() {
  const azCommand = findAzureCli();
  debug(`Using Azure CLI command: ${azCommand}`);
  const command = [
    "&",
    quoteForPowerShell(azCommand),
    "account",
    "get-access-token",
    "--resource",
    quoteForPowerShell(FABRIC_RESOURCE),
    "--query",
    "accessToken",
    "-o",
    "tsv"
  ].join(" ");

  const output = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000
    }
  );

  const token = output.trim();
  debug(`Azure CLI token output length: ${token.length}`);

  if (!token) {
    throw new Error("Azure CLI did not return an access token.");
  }

  return token;
}

function getToken() {
  const envToken = process.env.FABRIC_MCP_TOKEN?.trim();
  if (process.env.FABRIC_MCP_USE_ENV_TOKEN === "1" && envToken) {
    return envToken;
  }

  const now = Date.now();
  if (cachedToken && now - tokenFetchedAt < 45 * 60 * 1000) {
    return cachedToken;
  }

  cachedToken = getAzureCliToken();
  tokenFetchedAt = now;
  return cachedToken;
}

async function closeRemote() {
  if (remoteClient) {
    try {
      await remoteClient.close();
    } catch {
      // Ignore close errors; the next request creates a fresh connection.
    }
  }

  if (remoteTransport) {
    try {
      await remoteTransport.close();
    } catch {
      // Same as above.
    }
  }

  remoteClient = undefined;
  remoteTransport = undefined;
}

async function connectRemote(force = false) {
  if (remoteClient && !force) {
    return remoteClient;
  }

  await closeRemote();

  const token = getToken();
  remoteTransport = new StreamableHTTPClientTransport(new URL(FABRIC_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });

  remoteClient = new Client(
    {
      name: "fabric-mcp-proxy",
      version: "1.0.0"
    },
    {
      capabilities: {}
    }
  );

  await remoteClient.connect(remoteTransport);
  return remoteClient;
}

async function callRemote(fn) {
  try {
    const client = await connectRemote();
    return await fn(client);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes("401") || message.includes("Unauthorized")) {
      cachedToken = undefined;
      tokenFetchedAt = 0;
      const client = await connectRemote(true);
      return await fn(client);
    }

    throw error;
  }
}

const server = new Server(
  {
    name: "fabric-remote-core-proxy",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () =>
  callRemote((client) => client.listTools())
);

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callRemote((client) => client.callTool(request.params))
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
  callRemote((client) => client.listResources(request.params))
);

server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
  callRemote((client) => client.readResource(request.params))
);

server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
  callRemote((client) => client.listResourceTemplates(request.params))
);

server.setRequestHandler(ListPromptsRequestSchema, async (request) =>
  callRemote((client) => client.listPrompts(request.params))
);

server.setRequestHandler(GetPromptRequestSchema, async (request) =>
  callRemote((client) => client.getPrompt(request.params))
);

process.on("SIGINT", async () => {
  await closeRemote();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeRemote();
  process.exit(0);
});

if (process.argv.includes("--token-test")) {
  const token = getToken();
  console.log(JSON.stringify({ tokenLength: token.length }));
  process.exit(0);
}

try {
  await server.connect(new StdioServerTransport());
  log(`Proxy ready: stdio -> ${FABRIC_MCP_URL}`);
} catch (error) {
  log(error?.stack ?? String(error));
  process.exit(1);
}
