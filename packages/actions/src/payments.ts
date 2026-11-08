/**
 * Agentic payment protocols (for example ACP, AP2 or UCP) plug in here.
 *
 * An adapter takes an approved order and either completes payment through the protocol, using a payment
 * credential the agent presents (a delegated, scoped token the person's payment provider issued),
 * or explains why it can't. AgenticWeb never sees card numbers: tokens go straight to the provider.
 *
 * The UCP and ACP checkout bridges (packages/runtime/src/commerce.ts) call the adapter when an agent completes
 * a checkout session: `input` is { items: [{ sku, quantity }] }, and `credential` is the ACP payment_data.token
 * or the selected UCP payment instrument as JSON. The adapter works out the final amount (tax, shipping)
 * and charges it with the payment provider. Return data.order_id (and data.order_url) on success.
 *
 * Register it with createEngine({ payments: { myProvider: adapter } }), then add an action with
 * confirmation "payment_protocol", an `items` input and backend.config.paymentAdapter "myProvider".
 */
export type PaymentRequest = {
  action: string;
  /** Validated action input (items, quantities, buyer details…). */
  input: Record<string, unknown>;
  /** Credential presented by the agent, e.g. from the Authorization or a protocol-specific header. */
  credential?: string;
  /** Who is paying, as identified by the agent's request. */
  agent: string;
  idempotencyKey?: string;
};

export type PaymentResult =
  | { status: "done"; message: string; data?: Record<string, unknown> }
  | { status: "checkout_link"; message: string; checkout_url: string }
  | { status: "rejected" | "failed"; message: string };

export interface PaymentAdapter {
  id: string;
  /** Short description shown to agents in the action's note. */
  describe(): string;
  pay(req: PaymentRequest): Promise<PaymentResult>;
}
