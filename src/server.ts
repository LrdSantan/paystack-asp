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

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", service: "paystack-payment-processor" }));

app.post("/mcp", async (req, res) => {
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
app.listen(PORT, () => {
  console.log(`Paystack Payment Processor MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
