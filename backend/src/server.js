import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { createStore } from "./store.js";
import { quotationTotals } from "./seed.js";

const app = express();
const store = await createStore();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "vendorbridge-demo-secret";
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  : [process.env.CLIENT_URL, "http://localhost:5173", "http://localhost:5174"].filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.includes(origin) ||
                      origin.startsWith("http://localhost:") ||
                      origin.startsWith("http://127.0.0.1:") ||
                      /\.vercel\.app$/.test(origin);
    callback(null, isAllowed ? origin : false);
  },
  credentials: true
}));
app.options("*", cors());
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

const communityRoles = new Set(["Procurement Officer", "Manager / Approver"]);
const publicUser = async ({ password, ...user }) => {
  if (!user.communityId) return user;
  const community = await store.get("communities", user.communityId);
  return { ...user, communityName: community?.name || null };
};
const sign = (user) => jwt.sign({ id: user.id, role: user.role, communityId: user.communityId || null }, JWT_SECRET, { expiresIn: "8h" });
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await store.get("users", payload.id);
    if (!req.user) throw new Error("User not found");
    next();
  } catch {
    res.status(401).json({ message: "Please sign in to continue." });
  }
};
const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ message: "Your role cannot perform this action." });
const requireCommunity = (req, res, next) => communityRoles.has(req.user.role) && !req.user.communityId
  ? res.status(403).json({ message: "Your account is not linked to a community." })
  : next();
const sameCommunity = (user, resource) => !resource?.communityId || !user.communityId || resource.communityId === user.communityId;
const byCommunity = (items, communityId) => communityId ? items.filter((item) => item.communityId === communityId) : items;
const activity = (type, message, communityId = null) => store.create("activities", { type, message, date: new Date().toISOString(), ...(communityId ? { communityId } : {}) });
const findCommunityByName = async (name) => {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return null;
  const communities = await store.list("communities");
  return communities.find((community) => community.name.toLowerCase() === normalized) || null;
};
const inviteLinkFor = (token) => {
  const clientUrl = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${clientUrl}?invite=${token}`;
};
const resolveCommunityOnSignup = async (account) => {
  if (account.inviteToken) {
    if (account.role !== "Manager / Approver") return { error: "This invitation link is only for Manager / Approver sign up." };
    const invite = await store.findOne("communityInvites", (item) => item.token === account.inviteToken && item.status === "Pending");
    if (!invite) return { error: "This invitation link is invalid or has already been used." };
    if (invite.email && invite.email.toLowerCase() !== String(account.email).toLowerCase()) {
      return { error: "Please sign up with the email address this invitation was sent to." };
    }
    await store.update("communityInvites", invite.id, { status: "Accepted", acceptedAt: new Date().toISOString(), acceptedEmail: account.email });
    return { communityId: invite.communityId };
  }
  if (account.role === "Procurement Officer") {
    const communityName = String(account.additionalInfo || "").trim();
    if (!communityName) return { error: "Enter your community name in Additional Information when registering as Procurement Officer." };
    if (await findCommunityByName(communityName)) return { error: "A community with this name already exists. Choose a different name." };
    const community = await store.create("communities", { name: communityName, createdAt: new Date().toISOString() });
    return { communityId: community.id, additionalInfo: communityName };
  }
  if (account.role === "Manager / Approver") {
    const invite = await store.findOne("communityInvites", (item) => item.email && item.email.toLowerCase() === String(account.email).toLowerCase() && item.status === "Pending");
    if (invite) {
      await store.update("communityInvites", invite.id, { status: "Accepted", acceptedAt: new Date().toISOString() });
      return { communityId: invite.communityId };
    }
    const communityName = String(account.additionalInfo || "").trim();
    if (!communityName) return { error: "Use the invitation link from your procurement officer, or enter your community name in Additional Information." };
    const community = await findCommunityByName(communityName);
    if (!community) return { error: "Community not found. Ask your procurement officer for the correct community name or an email invite." };
    return { communityId: community.id, additionalInfo: communityName };
  }
  return {};
};
const enriched = async () => {
  const [vendors, rfqs, quotations, approvals, purchaseOrders, invoices] = await Promise.all([
    store.list("vendors"), store.list("rfqs"), store.list("quotations"), store.list("approvals"), store.list("purchaseOrders"), store.list("invoices")
  ]);
  const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v]));
  const rfqMap = Object.fromEntries(rfqs.map((r) => [r.id, r]));
  const quotationMap = Object.fromEntries(quotations.map((q) => [q.id, q]));
  return {
    vendors, rfqs,
    quotations: quotations.map((q) => ({ ...q, vendor: vendorMap[q.vendorId], rfq: rfqMap[q.rfqId], ...quotationTotals(q) })),
    approvals: approvals.map((a) => ({ ...a, quotation: quotationMap[a.quotationId], rfq: rfqMap[a.rfqId], vendor: vendorMap[quotationMap[a.quotationId]?.vendorId] })),
    purchaseOrders: purchaseOrders.map((po) => ({ ...po, vendor: vendorMap[po.vendorId], rfq: rfqMap[po.rfqId] })),
    invoices: invoices.map((i) => ({ ...i, vendor: vendorMap[i.vendorId], purchaseOrder: purchaseOrders.find((po) => po.id === i.poId) }))
  };
};

app.get("/api/health", (_req, res) => res.json({ ok: true, database: process.env.USE_MEMORY_DB === "false" ? "mongodb" : "memory" }));

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = req.body.password;
  if (!email || typeof password !== "string") {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const user = await store.findOne(
    "users",
    (item) => item.email.toLowerCase() === email.toLowerCase()
  );

  const valid = !!user && (await bcrypt.compare(password, user.password).catch(() => false));
  if (!valid) return res.status(401).json({ message: "Invalid email or password." });
  if (user.status === "Disabled") return res.status(403).json({ message: "This account has been disabled by an administrator." });
  res.json({ token: sign(user), user: await publicUser(user) });
});
app.post("/api/auth/signup", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = req.body.password;

  if (!email || typeof password !== "string" || !password.trim()) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const exists = await store.findOne("users", (item) => item.email.toLowerCase() === email.toLowerCase());
  if (exists) return res.status(409).json({ message: "An account with this email already exists." });

  const { companyName, category, gst, inviteToken, ...account } = req.body;

  if (!account.role) {
    return res.status(400).json({ message: "Role is required." });
  }

  const communityResult = await resolveCommunityOnSignup({ ...account, inviteToken });
  if (communityResult.error) return res.status(400).json({ message: communityResult.error });

  let vendorId;
  if (account.role === "Vendor") {
    const vendor = await store.create("vendors", {
      name: companyName || `${account.firstName} ${account.lastName}`,
      category: category || "General Supplies",
      gst: gst || "Pending verification",
      contact: account.phone || "",
      email: account.email,
      status: "Pending",
      rating: 0
    });
    vendorId = vendor.id;
    await activity("Vendor", `Vendor registered - ${vendor.name} is pending verification`);
  }

  const user = await store.create("users", {
    ...account,
    ...(communityResult.communityId ? { communityId: communityResult.communityId } : {}),
    ...(communityResult.additionalInfo !== undefined ? { additionalInfo: communityResult.additionalInfo } : {}),
    ...(vendorId ? { vendorId } : {}),
    status: "Active",
    password: await bcrypt.hash(password, 10)
  });

  if (communityResult.communityId && account.role === "Procurement Officer") {
    await store.update("communities", communityResult.communityId, { createdBy: user.id });
    await activity("User", `${user.firstName} ${user.lastName} created community ${communityResult.additionalInfo}`, communityResult.communityId);
  }

  await activity("User", `${user.firstName} ${user.lastName} created a ${user.role} account`, communityResult.communityId || null);
  res.status(201).json({ token: sign(user), user: await publicUser(user) });
});
app.post("/api/auth/forgot-password", async (req, res) => res.json({ message: `A reset link has been prepared for ${req.body.email}.` }));
app.get("/api/auth/me", auth, async (req, res) => res.json(await publicUser(req.user)));

app.get("/api/bootstrap", auth, async (_req, res) => {
  const data = await enriched();
  const [activities, notifications, users] = await Promise.all([store.list("activities"), store.list("notifications"), store.list("users")]);
  if (_req.user.role === "Vendor") {
    const vendorId = _req.user.vendorId;
    const rfqs = data.rfqs.filter((rfq) => rfq.vendorIds.includes(vendorId));
    const quotations = data.quotations.filter((quotation) => quotation.vendorId === vendorId);
    const purchaseOrders = data.purchaseOrders.filter((po) => po.vendorId === vendorId);
    return res.json({
      vendors: data.vendors.filter((vendor) => vendor.id === vendorId),
      rfqs,
      quotations,
      approvals: [],
      purchaseOrders,
      invoices: [],
      activities: activities.filter((item) => ["RFQ", "Quotation", "Purchase Order"].includes(item.type)),
      notifications: notifications.filter((item) => !item.title?.toLowerCase().includes("approval")),
      users: []
    });
  }
  if (_req.user.role === "Manager / Approver") {
    const communityId = _req.user.communityId;
    const approvals = byCommunity(data.approvals, communityId);
    const rfqIds = new Set(approvals.map((approval) => approval.rfqId));
    const quotationIds = new Set(approvals.map((approval) => approval.quotationId));
    const communityActivities = byCommunity(activities, communityId);
    return res.json({
      vendors: data.vendors,
      rfqs: data.rfqs.filter((rfq) => rfqIds.has(rfq.id)),
      quotations: data.quotations.filter((quotation) => quotationIds.has(quotation.id)),
      approvals,
      purchaseOrders: byCommunity(data.purchaseOrders, communityId),
      invoices: [],
      activities: communityActivities.filter((item) => ["Approval", "Quotation", "Purchase Order"].includes(item.type)),
      notifications: notifications.filter((item) => item.title?.toLowerCase().includes("approval")),
      users: []
    });
  }
  if (_req.user.role === "Procurement Officer") {
    const communityId = _req.user.communityId;
    const rfqs = byCommunity(data.rfqs, communityId);
    const rfqIds = new Set(rfqs.map((rfq) => rfq.id));
    const quotations = data.quotations.filter((quotation) => rfqIds.has(quotation.rfqId));
    const approvals = byCommunity(data.approvals, communityId);
    const communityActivities = byCommunity(activities, communityId);
    return res.json({
      vendors: data.vendors,
      rfqs,
      quotations,
      approvals,
      purchaseOrders: byCommunity(data.purchaseOrders, communityId),
      invoices: byCommunity(data.invoices, communityId),
      activities: communityActivities,
      notifications: byCommunity(notifications, communityId),
      users: []
    });
  }
  res.json({
    ...data,
    activities,
    notifications,
    users: _req.user.role === "Admin" ? await Promise.all(users.map(publicUser)) : []
  });
});

app.get("/api/community/join/:token", async (req, res) => {
  const invite = await store.findOne("communityInvites", (item) => item.token === req.params.token && item.status === "Pending");
  if (!invite) return res.status(404).json({ message: "This invitation link is invalid or has already been used." });
  const community = await store.get("communities", invite.communityId);
  res.json({
    communityName: community?.name || "Procurement Community",
    role: invite.role || "Manager / Approver",
    email: invite.email || null
  });
});

app.post("/api/community/invite", auth, allow("Procurement Officer"), requireCommunity, async (req, res) => {
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
  if (email) {
    const existingUser = await store.findOne("users", (item) => item.email.toLowerCase() === email);
    if (existingUser) return res.status(409).json({ message: "This email already has an account." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  const invite = await store.create("communityInvites", {
    communityId: req.user.communityId,
    token,
    email,
    role: "Manager / Approver",
    invitedBy: req.user.id,
    status: "Pending",
    createdAt: new Date().toISOString()
  });
  const community = await store.get("communities", req.user.communityId);
  const inviteLink = inviteLinkFor(token);
  await activity("User", `${req.user.firstName} ${req.user.lastName} created a manager invite for ${community?.name || "their community"}`, req.user.communityId);
  res.status(201).json({
    message: email ? `Invitation link prepared for ${email}.` : "Manager invitation link created.",
    invite,
    inviteLink
  });
});

app.patch("/api/users/:id", auth, allow("Admin"), async (req, res) => {
  const allowed = Object.fromEntries(Object.entries(req.body).filter(([key]) => ["role", "status"].includes(key)));
  const user = await store.update("users", req.params.id, allowed);
  if (!user) return res.status(404).json({ message: "User not found." });
  await activity("User", `${user.firstName} ${user.lastName}'s access was updated`, user.communityId || null);
  res.json(await publicUser(user));
});

app.post("/api/vendors", auth, allow("Admin"), async (req, res) => {
  const vendor = await store.create("vendors", { rating: 0, status: "Pending", ...req.body });
  await activity("Vendor", `Vendor added - ${vendor.name} registered with ${vendor.status} status`);
  res.status(201).json(vendor);
});
app.patch("/api/vendors/:id", auth, allow("Procurement Officer", "Admin"), async (req, res) => res.json(await store.update("vendors", req.params.id, req.body)));

app.post("/api/rfqs", auth, allow("Procurement Officer"), requireCommunity, async (req, res) => {
  const rfqs = await store.list("rfqs");
  const rfq = await store.create("rfqs", {
    ...req.body,
    communityId: req.user.communityId,
    createdBy: req.user.id,
    number: `RFQ-${new Date().getFullYear()}-${String(rfqs.length + 43).padStart(3, "0")}`,
    status: req.body.status || "Open",
    createdAt: new Date().toISOString()
  });
  await activity("RFQ", `RFQ published - ${rfq.title} sent to ${rfq.vendorIds.length} vendors`, req.user.communityId);
  res.status(201).json(rfq);
});

app.post("/api/quotations", auth, allow("Vendor"), async (req, res) => {
  const previous = await store.findOne("quotations", (q) => q.rfqId === req.body.rfqId && q.vendorId === req.body.vendorId);
  const quotation = previous
    ? await store.update("quotations", previous.id, { ...req.body, status: req.body.status || "Submitted", updatedAt: new Date().toISOString() })
    : await store.create("quotations", { ...req.body, status: req.body.status || "Submitted", createdAt: new Date().toISOString() });
  const vendor = await store.get("vendors", quotation.vendorId);
  await activity("Quotation", `${vendor?.name || "Vendor"} ${previous ? "updated" : "submitted"} a quotation`);
  res.status(previous ? 200 : 201).json({ ...quotation, ...quotationTotals(quotation) });
});

app.post("/api/approvals", auth, allow("Procurement Officer"), requireCommunity, async (req, res) => {
  const rfq = await store.get("rfqs", req.body.rfqId);
  if (!rfq || !sameCommunity(req.user, rfq)) return res.status(403).json({ message: "You can only start approvals for RFQs in your community." });
  const approval = await store.create("approvals", {
    rfqId: req.body.rfqId,
    quotationId: req.body.quotationId,
    communityId: req.user.communityId,
    status: "Pending L1",
    currentLevel: 1,
    remarks: "",
    timeline: [{ label: "Submitted", by: req.user.firstName + " " + req.user.lastName, date: new Date().toISOString(), state: "done" }, { label: "L1 Review", by: "Manager", date: null, state: "current" }, { label: "L2 Approval", by: "Finance", date: null, state: "upcoming" }, { label: "Generate PO", by: "System", date: null, state: "upcoming" }]
  });
  await activity("Approval", "Quotation selected and approval workflow initiated", req.user.communityId);
  res.status(201).json(approval);
});

app.patch("/api/approvals/:id", auth, allow("Manager / Approver"), requireCommunity, async (req, res) => {
  const current = await store.get("approvals", req.params.id);
  if (!current) return res.status(404).json({ message: "Approval not found." });
  if (!sameCommunity(req.user, current)) return res.status(403).json({ message: "This approval belongs to another community." });
  const rejected = req.body.action === "reject";
  let status = rejected ? "Rejected" : current.currentLevel === 1 ? "Pending L2" : "Approved";
  let level = rejected ? current.currentLevel : Math.min(current.currentLevel + 1, 3);
  const timeline = current.timeline.map((step, index) => {
    if (index === current.currentLevel) return { ...step, date: new Date().toISOString(), state: rejected ? "rejected" : "done", by: `${req.user.firstName} ${req.user.lastName}` };
    if (!rejected && index === current.currentLevel + 1) return { ...step, state: "current" };
    return step;
  });
  const approval = await store.update("approvals", current.id, { status, currentLevel: level, remarks: req.body.remarks || current.remarks, timeline });
  let generated = null;
  if (status === "Approved") {
    const quotation = await store.get("quotations", current.quotationId);
    const totals = quotationTotals(quotation);
    const pos = await store.list("purchaseOrders");
    const po = await store.create("purchaseOrders", { number: `PO-${new Date().getFullYear()}-${String(pos.length + 68).padStart(4, "0")}`, quotationId: quotation.id, rfqId: quotation.rfqId, vendorId: quotation.vendorId, communityId: current.communityId, status: "Approved", issueDate: new Date().toISOString().slice(0, 10), total: totals.total });
    const invoices = await store.list("invoices");
    const due = new Date(); due.setDate(due.getDate() + 30);
    const invoice = await store.create("invoices", { number: `INV-${new Date().getFullYear()}-${String(invoices.length + 149).padStart(4, "0")}`, poId: po.id, vendorId: po.vendorId, communityId: current.communityId, issueDate: new Date().toISOString().slice(0, 10), dueDate: due.toISOString().slice(0, 10), status: "Pending Payment", ...totals });
    generated = { po, invoice };
    await activity("Purchase Order", `${po.number} and ${invoice.number} generated after approval`, current.communityId);
  } else {
    await activity("Approval", `Procurement request ${status.toLowerCase()} by ${req.user.firstName} ${req.user.lastName}`, current.communityId);
  }
  res.json({ approval, generated });
});

app.patch("/api/invoices/:id", auth, allow("Procurement Officer"), requireCommunity, async (req, res) => {
  const current = await store.get("invoices", req.params.id);
  if (!current) return res.status(404).json({ message: "Invoice not found." });
  if (!sameCommunity(req.user, current)) return res.status(403).json({ message: "This invoice belongs to another community." });
  const invoice = await store.update("invoices", req.params.id, req.body);
  await activity("Invoice", `${invoice.number} status changed to ${invoice.status}`, req.user.communityId);
  res.json(invoice);
});

function invoicePdf(res, invoice, vendor, po) {
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${invoice.number}.pdf`);
  doc.pipe(res);
  doc.fontSize(28).fillColor("#6d5dfc").text("VendorBridge");
  doc.moveDown().fontSize(20).fillColor("#111827").text("TAX INVOICE");
  doc.fontSize(10).fillColor("#4b5563").text(`Invoice: ${invoice.number}`).text(`Purchase Order: ${po?.number || "-"}`).text(`Issue date: ${invoice.issueDate}`).text(`Due date: ${invoice.dueDate}`);
  doc.moveDown().fontSize(12).fillColor("#111827").text(`Vendor: ${vendor?.name || "-"}`).text(`GSTIN: ${vendor?.gst || "-"}`).text(`Contact: ${vendor?.email || "-"}`);
  doc.moveDown(2).fontSize(11).text(`Subtotal: INR ${invoice.subtotal.toLocaleString("en-IN")}`).text(`Tax: INR ${invoice.tax.toLocaleString("en-IN")}`).fontSize(14).text(`Grand total: INR ${invoice.total.toLocaleString("en-IN")}`);
  doc.moveDown(3).fontSize(9).fillColor("#6b7280").text("Generated by VendorBridge Procurement ERP");
  doc.end();
}
app.get("/api/invoices/:id/pdf", auth, async (req, res) => {
  const invoice = await store.get("invoices", req.params.id);
  if (!invoice) return res.status(404).json({ message: "Invoice not found." });
  if (communityRoles.has(req.user.role) && !sameCommunity(req.user, invoice)) return res.status(403).json({ message: "This invoice belongs to another community." });
  invoicePdf(res, invoice, await store.get("vendors", invoice.vendorId), await store.get("purchaseOrders", invoice.poId));
});
app.post("/api/invoices/:id/email", auth, allow("Procurement Officer"), requireCommunity, async (req, res) => {
  const invoice = await store.get("invoices", req.params.id);
  if (!invoice) return res.status(404).json({ message: "Invoice not found." });
  if (!sameCommunity(req.user, invoice)) return res.status(403).json({ message: "This invoice belongs to another community." });
  const vendor = await store.get("vendors", invoice.vendorId);
  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transporter.sendMail({ from: process.env.SMTP_USER, to: req.body.email || vendor.email, subject: `Invoice ${invoice.number}`, text: `Invoice ${invoice.number} for INR ${invoice.total.toLocaleString("en-IN")} is attached to your VendorBridge account.` });
  }
  await activity("Invoice", `${invoice.number} emailed to ${req.body.email || vendor.email}`, req.user.communityId);
  res.json({ message: `Invoice sent to ${req.body.email || vendor.email}${process.env.SMTP_HOST ? "" : " (demo mode)"}.` });
});

app.get("/api/reports/export", auth, async (_req, res) => {
  let { vendors, purchaseOrders, invoices } = await enriched();
  if (_req.user.role === "Procurement Officer" || _req.user.role === "Manager / Approver") {
    purchaseOrders = byCommunity(purchaseOrders, _req.user.communityId);
    invoices = byCommunity(invoices, _req.user.communityId);
  }
  const rows = [["Metric", "Value"], ["Active vendors", vendors.filter((v) => v.status === "Active").length], ["Purchase orders", purchaseOrders.length], ["Invoices", invoices.length], ["Total spend", invoices.reduce((sum, i) => sum + i.total, 0)]];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=vendorbridge-report.csv");
  res.send(rows.map((row) => row.join(",")).join("\n"));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || "Something went wrong." });
});
app.listen(PORT, () => console.log(`VendorBridge API running on http://localhost:${PORT}`));
