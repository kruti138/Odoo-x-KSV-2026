import { quotationTotals } from "../seed.js";

export class RecommendationService {
  constructor(store) {
    this.store = store;
    this.DEFAULT_RELIABILITY = 70; // default when no history
  }

  async vendorReliabilityScore(vendorId, organizationId) {
    // Use approvals (approved), purchaseOrders (completed), invoices (paid), quotations participation
    const [approvals, purchaseOrders, invoices, quotations] = await Promise.all([
      this.store.list("approvals"),
      this.store.list("purchaseOrders"),
      this.store.list("invoices"),
      this.store.list("quotations")
    ]);

    const orgApprovals = approvals.filter((a) => !organizationId || a.organizationId === organizationId);
    const orgPOs = purchaseOrders.filter((p) => !organizationId || p.organizationId === organizationId);
    const orgInvoices = invoices.filter((i) => !organizationId || i.organizationId === organizationId);
    const orgQuots = quotations.filter((q) => !organizationId || q.organizationId === organizationId);

    const approvedCount = orgApprovals.filter((a) => a.vendorId === vendorId && a.status === "Approved").length;
    const poCount = orgPOs.filter((p) => p.vendorId === vendorId && p.status === "Approved").length;
    const invoicePaid = orgInvoices.filter((i) => i.vendorId === vendorId && i.status === "Paid").length;
    const participation = orgQuots.filter((q) => q.vendorId === vendorId).length;

    const total = approvedCount + poCount + invoicePaid + participation;
    if (total === 0) return this.DEFAULT_RELIABILITY;

    // Weighted reliability: approvals 40%, POs 30%, invoices 20%, participation 10%
    const score = Math.min(100, Math.round((approvedCount * 0.4 + poCount * 0.3 + invoicePaid * 0.2 + participation * 0.1) / Math.max(1, total) * 100));
    return score;
  }

  normalizeScores(values, lowerIsBetter = true) {
    if (!values.length) return [];
    const nums = values.map((v) => (v == null ? 0 : v));
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (max === min) return nums.map(() => 100);
    return nums.map((v) => {
      if (lowerIsBetter) {
        return Math.round(((max - v) / (max - min)) * 100);
      }
      return Math.round(((v - min) / (max - min)) * 100);
    });
  }

  async calculateForRfq(rfqId) {
    const [quotations, vendors, rfqs] = await Promise.all([this.store.list("quotations"), this.store.list("vendors"), this.store.list("rfqs")]);
    const rfq = rfqs.find((r) => r.id === rfqId);
    const orgId = rfq?.organizationId || rfq?.communityId || null;
    const quotes = quotations.filter((q) => q.rfqId === rfqId);
    if (!quotes.length) return { rankings: [], badges: {}, scores: {} };

    // Gather raw metrics
    const prices = quotes.map((q) => {
      const totals = quotationTotals(q);
      return totals.total || 0;
    });
    const deliveries = quotes.map((q) => (Number(q.deliveryDays) || null));

    // Normalize price (lower better) and delivery (lower better)
    const priceScore = this.normalizeScores(prices, true);
    // For delivery, missing values should be treated as high (worse)
    const deliveryValues = deliveries.map((d) => (d == null ? Math.max(...deliveries.filter(Boolean), 30) : d));
    const deliveryScore = this.normalizeScores(deliveryValues, true);

    // Reliability per vendor
    const reliabilityPromises = quotes.map((q) => this.vendorReliabilityScore(q.vendorId, orgId));
    const reliabilityRaw = await Promise.all(reliabilityPromises);
    const reliabilityScore = this.normalizeScores(reliabilityRaw, false);

    // Weighted final score: Price 50%, Delivery 30%, Reliability 20%
    const finalScores = quotes.map((q, idx) => Math.round((priceScore[idx] * 0.5) + (deliveryScore[idx] * 0.3) + (reliabilityScore[idx] * 0.2)));

    // Build ranking objects
    const items = quotes.map((q, idx) => ({
      quotationId: q.id,
      vendorId: q.vendorId,
      price: prices[idx],
      deliveryDays: deliveries[idx],
      reliabilityRaw: reliabilityRaw[idx],
      score: finalScores[idx]
    }));

    // Sort by score desc
    const ranked = [...items].sort((a, b) => b.score - a.score || a.price - b.price);
    const rankings = ranked.map((item, index) => ({ rank: index + 1, ...item }));

    // Badges
    const badges = {};
    // Lowest Cost
    const minPrice = Math.min(...prices);
    const lowestIdx = items.findIndex((it) => it.price === minPrice);
    if (lowestIdx >= 0) badges[items[lowestIdx].vendorId] = (badges[items[lowestIdx].vendorId] || []).concat("Lowest Cost");
    // Fastest Delivery (ignore nulls by treating missing as worst)
    const validDelivery = items.filter((it) => it.deliveryDays != null);
    if (validDelivery.length) {
      const minDelivery = Math.min(...validDelivery.map((d) => d.deliveryDays));
      const fast = items.find((it) => it.deliveryDays === minDelivery);
      if (fast) badges[fast.vendorId] = (badges[fast.vendorId] || []).concat("Fastest Delivery");
    }
    // Most Reliable
    const maxReli = Math.max(...items.map((it) => it.reliabilityRaw || 0));
    const reli = items.find((it) => (it.reliabilityRaw || 0) === maxReli);
    if (reli) badges[reli.vendorId] = (badges[reli.vendorId] || []).concat("Most Reliable");
    // Best Overall: top ranked
    if (rankings.length) {
      const best = rankings[0];
      badges[best.vendorId] = (badges[best.vendorId] || []).concat("Best Overall");
    }

    const scores = Object.fromEntries(items.map((it) => [it.vendorId, it.score]));

    return { recommendedVendor: rankings[0] || null, rankings, badges, scores };
  }

  async recalculateForRfq(rfqId) {
    const result = await this.calculateForRfq(rfqId);
    // Log activity
    const rfqs = await this.store.list("rfqs");
    const rfq = rfqs.find((r) => r.id === rfqId);
    const orgId = rfq?.organizationId || rfq?.communityId || null;
    await this.store.create("activities", { type: "Recommendation", message: `Smart recommendation generated for RFQ ${rfq?.number || rfqId}`, date: new Date().toISOString(), ...(orgId ? { organizationId: orgId } : {}) });
    return result;
  }
}

export default RecommendationService;
