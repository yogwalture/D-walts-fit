import {
  createOrder,
  fetchPayment,
  verifyCheckoutSignature,
} from '@gym/integrations';
import type { GatewayPort } from '@gym/core';

/**
 * The real gateway, wired once.
 *
 * The services take this as a parameter so their tests can run without the
 * internet. That seam exists for testability, not as a place to fake a
 * payment: there is exactly one production implementation and it is here.
 */
export const razorpayPort: GatewayPort = {
  createOrder: (config, input) => createOrder(config, input),
  fetchPayment: (config, paymentId) => fetchPayment(config, paymentId),
  verifyCheckoutSignature: (config, input) => verifyCheckoutSignature(config, input),
};
