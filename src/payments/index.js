// Gateway registry. A gateway implements: createPayment(order, ctx), verifyReturn(params), checkStatus(order),
// refund(order, amountMinor, refundId). ICICI Bank is the only payment gateway.
const gateways = {
  icici: () => require("./IciciGateway"),
};

function getGateway(name = "icici") {
  if (!gateways[name]) throw new Error(`Unknown payment gateway "${name}"`);
  return gateways[name]();
}

module.exports = { getGateway };
