import { handlePayIssuerWebhook } from "../server/pay-issuer-webhook.js";
export const config = { api: { bodyParser: false } };
export default handlePayIssuerWebhook;
