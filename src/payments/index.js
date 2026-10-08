// Gateway registry. A gateway implements: createPayment(order, ctx), verifyReturn(params), checkStatus(order),
// refund(order, amountMinor, refundId). Only the one named by PAYMENT_GATEWAY is active.
const config = require("../config");

const gateways = {
  mock: () => require("./MockGateway"),
  icici: () => require("./IciciGateway"),
};

function getGateway(name = config.payment.gateway) {
  if (!gateways[name]) throw new Error(`Unknown payment gateway "${name}"`);
  return gateways[name]();
}

module.exports = { getGateway };
