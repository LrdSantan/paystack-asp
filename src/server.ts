import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  createPaymentLink,
  verifyTransaction,
  initiateTransfer,
  createTransferRecipient,
} from "./paystack";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";

// ---------------------------------------------------------------------------
// MCP server definition — this is the "Paystack Payment Processor" ASP.
// Each tool below is a capability an agent on OKX.AI can call and pay for.
// ---------------------------------------------------------------------------

function buildServer() {
  const server = new McpServer({
    name: "paystack-payment-processor",
    version: "1.0.0",
  });

  server.tool(
    "create_payment_link",
    "Create a Paystack payment link for a customer to pay. Returns a hosted checkout URL and a reference to track the transaction. Use for e-commerce, invoicing, ticketing, or any flow where a human or agent needs to pay in NGN (or other supported currency).",
    {
      email: z.string().email().describe("Customer's email address"),
      amount: z.number().positive().describe("Amount to charge, in the major currency unit (e.g. Naira, not kobo)"),
      currency: z.string().optional().describe("ISO currency code, defaults to NGN"),
      description: z.string().optional().describe("Human-readable description of what is being paid for"),
      reference: z.string().optional().describe("Optional custom reference; auto-generated if omitted"),
      callback_url: z.string().url().optional().describe("URL Paystack redirects to after payment"),
    },
    async (args) => {
      try {
        const result = await createPaymentLink(args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "verify_transaction",
    "Verify the status of a Paystack transaction by its reference. Returns whether payment succeeded, failed, or is pending, plus amount and payer details. Call this before treating any payment as confirmed.",
    {
      reference: z.string().describe("The transaction reference returned by create_payment_link"),
    },
    async ({ reference }) => {
      try {
        const result = await verifyTransaction(reference);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_transfer_recipient",
    "Register a bank account as a Paystack transfer recipient so it can later receive settlement payouts. Required once per recipient before calling initiate_transfer.",
    {
      account_number: z.string().describe("Recipient's bank account number"),
      bank_code: z.string().describe("Paystack bank code for the recipient's bank"),
      name: z.string().describe("Account holder's name"),
      currency: z.string().optional().describe("ISO currency code, defaults to NGN"),
    },
    async (args) => {
      try {
        const result = await createTransferRecipient(args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "initiate_transfer",
    "Settle funds from the Paystack balance to a previously registered transfer recipient (bank account). Use this to pay out collected funds automatically.",
    {
      amount: z.number().positive().describe("Amount to transfer, in the major currency unit"),
      recipient_code: z.string().describe("Recipient code returned by create_transfer_recipient"),
      reason: z.string().optional().describe("Reason shown on the transfer, e.g. 'invoice settlement'"),
      currency: z.string().optional().describe("ISO currency code, defaults to NGN"),
    },
    async (args) => {
      try {
        const result = await initiateTransfer(args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport — stateless per-request, matches OKX's "public HTTPS
// endpoint" requirement for A2MCP. Deploy this behind any Node host
// (Railway, Render, a small VPS, or Vercel with a custom server).
// ---------------------------------------------------------------------------

const NETWORK = "eip155:196" as const;
const PAY_TO = process.env.PAY_TO_ADDRESS || "0xb303077bf3a3877d0e1614487334919a8b349840";

const facilitator = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY || "",
  secretKey: process.env.OKX_SECRET_KEY || "",
  passphrase: process.env.OKX_PASSPHRASE || "",
});

const resourceServer = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactEvmScheme());

const priced = {
  scheme: "exact" as const,
  network: NETWORK,
  payTo: PAY_TO,
  price: "$0.03" as const,
  syncSettle: true as const,
};

const app = express();

// FIX (v2): The MCP transport's Node→Web-Standard request conversion
// (@hono/node-server) builds its Headers object from req.rawHeaders — the
// raw wire-format array — NOT from req.headers. Mutating req.headers.accept
// alone has no effect on what the transport actually sees. OKX's x402 replay
// client sends "Accept: */*", which fails the transport's requirement for
// both "application/json" and "text/event-stream". We strip any existing
// Accept header from the raw array and inject the correct one.
app.use((req, res, next) => {
  if (req.path === "/mcp" || req.path.startsWith("/mcp/")) {
    const filtered: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (key.toLowerCase() !== "accept") {
        filtered.push(key, value);
      }
    }
    filtered.push("Accept", "application/json, text/event-stream");
    req.rawHeaders = filtered;
    // Keep req.headers in sync too, in case anything else reads the parsed form
    req.headers.accept = "application/json, text/event-stream";
  }
  next();
});


app.use(express.json());

// Adapter layer to branch on JSON-RPC tool name before matching a route key in OKX SDK
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/mcp" && req.body?.method === "tools/call") {
    const toolName = req.body.params?.name;
    if (toolName) {
      req.url = `/mcp/${toolName}`;
    }
  }
  next();
});

app.use(
  paymentMiddleware(
    {
      "POST /mcp/create_payment_link": { accepts: [priced], description: "Create Paystack payment link" },
      "POST /mcp/verify_transaction": { accepts: [priced], description: "Verify Paystack transaction" },
      "POST /mcp/initiate_transfer": { accepts: [priced], description: "Initiate Paystack transfer" },
    },
    resourceServer,
    undefined,
    undefined,
    false,
  ),
);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "paystack-payment-processor" }));

app.post("/mcp*", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode: no session persistence needed for pay-per-call tools
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, async () => {
  try {
    await resourceServer.initialize(); // fetches supported kinds from facilitator on startup
    console.log("OKX x402 Resource Server initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize OKX x402 Resource Server:", err);
  }
  console.log(`Paystack Payment Processor MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});