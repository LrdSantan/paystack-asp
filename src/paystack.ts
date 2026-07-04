import axios from "axios";

const PAYSTACK_BASE = "https://api.paystack.co";

function client() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not set in environment variables");
  }
  return axios.create({
    baseURL: PAYSTACK_BASE,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

export interface CreatePaymentLinkParams {
  email: string;
  amount: number; // in the currency's major unit, e.g. Naira, not kobo
  currency?: string; // defaults to NGN
  description?: string;
  reference?: string;
  callback_url?: string;
}

export async function createPaymentLink(params: CreatePaymentLinkParams) {
  const { email, amount, currency = "NGN", description, reference, callback_url } = params;

  const payload: Record<string, unknown> = {
    email,
    amount: Math.round(amount * 100), // Paystack expects the smallest currency unit (kobo)
    currency,
    reference: reference ?? `asp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
  if (description) payload.metadata = { description };
  if (callback_url) payload.callback_url = callback_url;

  const { data } = await client().post("/transaction/initialize", payload);

  return {
    success: true,
    reference: data.data.reference,
    payment_link: data.data.authorization_url,
    access_code: data.data.access_code,
  };
}

export async function verifyTransaction(reference: string) {
  const { data } = await client().get(`/transaction/verify/${encodeURIComponent(reference)}`);
  const tx = data.data;
  return {
    success: true,
    status: tx.status, // "success" | "failed" | "abandoned"
    reference: tx.reference,
    amount: tx.amount / 100,
    currency: tx.currency,
    paid_at: tx.paid_at,
    channel: tx.channel,
    customer_email: tx.customer?.email,
  };
}

export interface InitiateTransferParams {
  amount: number; // major unit
  recipient_code: string; // Paystack transfer recipient code, must be created beforehand
  reason?: string;
  currency?: string;
}

export async function initiateTransfer(params: InitiateTransferParams) {
  const { amount, recipient_code, reason, currency = "NGN" } = params;

  const { data } = await client().post("/transfer", {
    source: "balance",
    amount: Math.round(amount * 100),
    recipient: recipient_code,
    reason: reason ?? "ASP settlement payout",
    currency,
  });

  return {
    success: true,
    transfer_code: data.data.transfer_code,
    status: data.data.status,
    reference: data.data.reference,
  };
}

export interface CreateTransferRecipientParams {
  account_number: string;
  bank_code: string;
  name: string;
  currency?: string;
}

export async function createTransferRecipient(params: CreateTransferRecipientParams) {
  const { account_number, bank_code, name, currency = "NGN" } = params;

  const { data } = await client().post("/transferrecipient", {
    type: "nuban",
    name,
    account_number,
    bank_code,
    currency,
  });

  return {
    success: true,
    recipient_code: data.data.recipient_code,
    details: data.data.details,
  };
}
