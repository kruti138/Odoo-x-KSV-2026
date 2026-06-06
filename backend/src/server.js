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
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

const communityRoles = new Set(["Procurement Officer", "Manager / Approver"]);
const getOrganizationId = (item) => item?.organizationId || item?.organization_id || item?.communityId || item?.community_id || null;
const normalizeOrganization = (item, organizationId, organizationName = null) => {
  if (!organizationId) return item;
  const resolvedName = organizationName ?? item.organizationName ?? item.organization_name;
  return {
    ...item,
    organizationId,
    organization_id: organizationId,
    communityId: organizationId,
    community_id: organizationId,
    organizationName: resolvedName || null,
    organization_name: resolvedName || null
  };
};
const inferOrganizationFromName = async (item) => {
  const organizationId = getOrganizationId(item);
  if (organizationId) return organizationId;
  const organizationName = String(item.organizationName || item.organization_name || item.additionalInfo || "").trim();
  if (!organizationName) return null;
  const organization = await findOrganizationByName(organizationName);
  return organization?.id || null;
};
const publicUser = async ({ password, ...user }) => {
  const organizationId = getOrganizationId(user) || await inferOrganizationFromName(user);
  if (!organizationId) return user;
  const organization = await store.get("communities", organizationId);
  return normalizeOrganization(user, organizationId, organization?.name || null);
};
const sign = (user) => {
  const organizationId = getOrganizationId(user);
  return jwt.sign({ id: user.id, role: user.role, organizationId, organization_id: organizationId }, JWT_SECRET, { expiresIn: "8h" });
};
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await store.get("users", payload.id);
    if (!req.user) throw new Error("User not found");
    const organizationId = getOrganizationId(req.user) || await inferOrganizationFromName(req.user);
    req.user.organizationId = organizationId;
    req.user.organization_id = organizationId;
    req.organizationId = organizationId;
    next();
  } catch {
    res.status(401).json({ message: "Please sign in to continue." });
  }
};
const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ message: "Your role cannot perform this action." });
const requireOrganization = (req, res, next) => {
  if (!req.organizationId) {
    return res.status(403).json({ message: "Your account is not linked to an organization." });
  }
  return next();
};
const sameOrganization = (user, resource) => {
  const userOrg = getOrganizationId(user);
  const resourceOrg = getOrganizationId(resource);
  if (!userOrg || !resourceOrg) return false;
  return userOrg === resourceOrg;
};
const scopeByOrganization = (items, organizationId) => organizationId ? items.filter((item) => getOrganizationId(item) === organizationId) : [];
const activity = (type, message, organizationId = null) => store.create("activities", { type, message, date: new Date().toISOString(), ...(organizationId ? { organizationId } : {}) });
const findOrganizationByName = async (name) => {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return null;
  const organizations = await store.list("communities");
  return organizations.find((organization) => organization.name.toLowerCase() === normalized) || null;
};
const inviteLinkFor = (token) => {
  const clientUrl = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${clientUrl}?invite=${token}`;
};
const resolveOrganizationOnSignup = async (account) => {
  if (account.inviteToken) {
    if (account.role !== "Manager / Approver") return { error: "This invitation link is only for Manager / Approver sign up." };
    const invite = await store.findOne("communityInvites", (item) => item.token === account.inviteToken && item.status === "Pending");
    if (!invite) return { error: "This invitation link is invalid or has already been used." };
    if (invite.email && invite.email.toLowerCase() !== String(account.email).toLowerCase()) {
      return { error: "Please sign up with the email address this invitation was sent to." };
    }
    await store.update("communityInvites", invite.id, { status: "Accepted", acceptedAt: new Date().toISOString(), acceptedEmail: account.email });
    return { organizationId: invite.organizationId || invite.communityId };
  }
  const organizationName = String(account.organizationName || account.additionalInfo || "").trim();
  if (!organizationName) return { error: "Enter your organization name to continue." };
  let organization = await findOrganizationByName(organizationName);
  if (!organization) {
    organization = await store.create("communities", { name: organizationName, organization_name: organizationName, createdAt: new Date().toISOString() });
  }
  return { organizationId: organization.id, organizationName: organization.name };
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

  const organizationResult = await resolveOrganizationOnSignup({ ...account, inviteToken });
  if (organizationResult.error) return res.status(400).json({ message: organizationResult.error });

  let vendorId;
  if (account.role === "Vendor") {
    const vendor = await store.create("vendors", normalizeOrganization({
      name: companyName || `${account.firstName} ${account.lastName}`,
      category: category || "General Supplies",
      gst: gst || "Pending verification",
      contact: account.phone || "",
      email: account.email,
      status: "Pending",
      rating: 0
    }, organizationResult.organizationId, organizationResult.organizationName));
    vendorId = vendor.id;
    await activity("Vendor", `Vendor registered - ${vendor.name} is pending verification`, organizationResult.organizationId || null);
  }

  const user = await store.create("users", normalizeOrganization({
    ...account,
    ...(vendorId ? { vendorId } : {}),
    status: "Active",
    password: await bcrypt.hash(password, 10)
  }, organizationResult.organizationId, organizationResult.organizationName));

  if (organizationResult.organizationId && account.role === "Procurement Officer") {
    await store.update("communities", organizationResult.organizationId, { createdBy: user.id });
    await activity("User", `${user.firstName} ${user.lastName} created organization ${organizationResult.organizationName}`, organizationResult.organizationId);
  }

  await activity("User", `${user.firstName} ${user.lastName} created a ${user.role} account`, organizationResult.organizationId || null);
  res.status(201).json({ token: sign(user), user: await publicUser(user) });
});
app.post("/api/auth/forgot-password", async (req, res) => res.json({ message: `A reset link has been prepared for ${req.body.email}.` }));
app.get("/api/auth/me", auth, async (req, res) => res.json(await publicUser(req.user)));

app.get("/api/bootstrap", auth, async (req, res) => {
  const organizationId = req.organizationId;
  if (!organizationId) {
    return res.status(403).json({ message: "Your account is not linked to an organization." });
  }
  const data = await enriched();
  const [activities, notifications, users] = await Promise.all([store.list("activities"), store.list("notifications"), store.list("users")]);
  if (req.user.role === "Vendor") {
    const vendorId = req.user.vendorId;
    const rfqs = scopeByOrganization(data.rfqs, organizationId).filter((rfq) => rfq.vendorIds.includes(vendorId));
    const quotations = scopeByOrganization(data.quotations, organizationId).filter((quotation) => quotation.vendorId === vendorId);
    const purchaseOrders = scopeByOrganization(data.purchaseOrders, organizationId).filter((po) => po.vendorId === vendorId);
    const invoices = scopeByOrganization(data.invoices, organizationId).filter((i) => i.vendorId === vendorId);
    return res.json({
      vendors: scopeByOrganization(data.vendors, organizationId).filter((vendor) => vendor.id === vendorId),
      rfqs,
      quotations,
      approvals: [],
      purchaseOrders,
      invoices,
      activities: scopeByOrganization(activities, organizationId).filter((item) => ["RFQ", "Quotation", "Purchase Order"].includes(item.type)),
      notifications: scopeByOrganization(notifications, organizationId).filter((item) => !item.title?.toLowerCase().includes("approval")),
      users: []
    });
  }
  if (req.user.role === "Manager / Approver") {
    const approvals = scopeByOrganization(data.approvals, organizationId);
    const rfqIds = new Set(approvals.map((approval) => approval.rfqId));
    const quotationIds = new Set(approvals.map((approval) => approval.quotationId));
    const organizationActivities = scopeByOrganization(activities, organizationId);
    return res.json({
      vendors: scopeByOrganization(data.vendors, organizationId),
      rfqs: scopeByOrganization(data.rfqs, organizationId).filter((rfq) => rfqIds.has(rfq.id)),
      quotations: scopeByOrganization(data.quotations, organizationId).filter((quotation) => quotationIds.has(quotation.id)),
      approvals,
      purchaseOrders: scopeByOrganization(data.purchaseOrders, organizationId),
      invoices: scopeByOrganization(data.invoices, organizationId),
      activities: organizationActivities.filter((item) => ["Approval", "Quotation", "Purchase Order"].includes(item.type)),
      notifications: scopeByOrganization(notifications, organizationId).filter((item) => item.title?.toLowerCase().includes("approval")),
      users: []
    });
  }
  if (req.user.role === "Procurement Officer") {
    const rfqs = scopeByOrganization(data.rfqs, organizationId);
    const rfqIds = new Set(rfqs.map((rfq) => rfq.id));
    const quotations = scopeByOrganization(data.quotations, organizationId).filter((quotation) => rfqIds.has(quotation.rfqId));
    const approvals = scopeByOrganization(data.approvals, organizationId);
    const organizationActivities = scopeByOrganization(activities, organizationId);
    return res.json({
      vendors: scopeByOrganization(data.vendors, organizationId),
      rfqs,
      quotations,
      approvals,
      purchaseOrders: scopeByOrganization(data.purchaseOrders, organizationId),
      invoices: scopeByOrganization(data.invoices, organizationId),
      activities: organizationActivities,
      notifications: scopeByOrganization(notifications, organizationId),
      users: []
    });
  }
  const adminUsers = scopeByOrganization(users, organizationId);
  res.json({
    vendors: scopeByOrganization(data.vendors, organizationId),
    rfqs: scopeByOrganization(data.rfqs, organizationId),
    quotations: scopeByOrganization(data.quotations, organizationId),
    approvals: scopeByOrganization(data.approvals, organizationId),
    purchaseOrders: scopeByOrganization(data.purchaseOrders, organizationId),
    invoices: scopeByOrganization(data.invoices, organizationId),
    activities: scopeByOrganization(activities, organizationId),
    notifications: scopeByOrganization(notifications, organizationId),
    users: req.user.role === "Admin" ? await Promise.all(adminUsers.map(publicUser)) : []
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

app.post("/api/community/invite", auth, allow("Procurement Officer"), requireOrganization, async (req, res) => {
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
  if (email) {
    const existingUser = await store.findOne("users", (item) => item.email.toLowerCase() === email);
    if (existingUser) return res.status(409).json({ message: "This email already has an account." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  const invite = await store.create("communityInvites", {
    organizationId: req.user.organizationId,
    communityId: req.user.organizationId,
    token,
    email,
    role: "Manager / Approver",
    invitedBy: req.user.id,
    status: "Pending",
    createdAt: new Date().toISOString()
  });
  const organization = await store.get("communities", req.user.organizationId);
  const inviteLink = inviteLinkFor(token);
  await activity("User", `${req.user.firstName} ${req.user.lastName} created a manager invite for ${organization?.name || "their organization"}`, req.user.organizationId);
  res.status(201).json({
    message: email ? `Invitation link prepared for ${email}.` : "Manager invitation link created.",
    invite,
    inviteLink
  });
});

app.patch("/api/users/:id", auth, allow("Admin"), async (req, res) => {
  const allowed = Object.fromEntries(Object.entries(req.body).filter(([key]) => ["role", "status"].includes(key)));
  const target = await store.get("users", req.params.id);
  if (!target) return res.status(404).json({ message: "User not found." });
  if (req.user.organizationId && !sameOrganization(req.user, target) && req.user.role === "Admin") {
    return res.status(403).json({ message: "You can only manage users in your organization." });
  }
  const user = await store.update("users", req.params.id, allowed);
  await activity("User", `${user.firstName} ${user.lastName}'s access was updated`, user.organizationId || null);
  res.json(await publicUser(user));
});

app.post("/api/vendors", auth, allow("Admin"), async (req, res) => {
  const vendor = await store.create("vendors", normalizeOrganization({ rating: 0, status: "Pending", ...req.body }, req.user.organizationId, req.user.organizationName));
  await activity("Vendor", `Vendor added - ${vendor.name} registered with ${vendor.status} status`, vendor.organizationId);
  res.status(201).json(vendor);
});
app.patch("/api/vendors/:id", auth, allow("Procurement Officer", "Admin"), async (req, res) => {
  const vendor = await store.get("vendors", req.params.id);
  if (!vendor) return res.status(404).json({ message: "Vendor not found." });
  if (req.user.organizationId && !sameOrganization(req.user, vendor)) {
    return res.status(403).json({ message: "You can only manage vendors in your organization." });
  }
  const updated = await store.update("vendors", req.params.id, req.body);
  res.json(updated);
});

app.post("/api/rfqs", auth, allow("Procurement Officer"), requireOrganization, async (req, res) => {
  const rfqs = await store.list("rfqs");
  const rfq = await store.create("rfqs", {
    ...req.body,
    organizationId: req.user.organizationId,
    communityId: req.user.organizationId,
    createdBy: req.user.id,
    number: `RFQ-${new Date().getFullYear()}-${String(rfqs.length + 43).padStart(3, "0")}`,
    status: req.body.status || "Open",
    createdAt: new Date().toISOString()
  });
  await activity("RFQ", `RFQ published - ${rfq.title} sent to ${rfq.vendorIds.length} vendors`, req.user.organizationId);
  res.status(201).json(rfq);
});

app.post("/api/quotations", auth, allow("Vendor"), async (req, res) => {
  if (req.body.vendorId && req.user.vendorId && req.body.vendorId !== req.user.vendorId) {
    return res.status(403).json({ message: "You may only submit quotations on behalf of your own vendor profile." });
  }
  const vendor = await store.get("vendors", req.body.vendorId || req.user.vendorId);
  if (!vendor) return res.status(404).json({ message: "Vendor profile not found." });
  if (req.user.organizationId && vendor.organizationId && req.user.organizationId !== vendor.organizationId) {
    return res.status(403).json({ message: "Vendor and user organization do not match." });
  }
  const rfq = await store.get("rfqs", req.body.rfqId);
  if (!rfq || !rfq.vendorIds.includes(vendor.id) || (rfq.organizationId && req.user.organizationId && rfq.organizationId !== req.user.organizationId)) {
    return res.status(403).json({ message: "You may only quote on RFQs assigned to your vendor profile within your organization." });
  }
  const previous = await store.findOne("quotations", (q) => q.rfqId === req.body.rfqId && q.vendorId === vendor.id);
  const quotation = previous
    ? await store.update("quotations", previous.id, { ...req.body, vendorId: vendor.id, organizationId: rfq.organizationId, status: req.body.status || "Submitted", updatedAt: new Date().toISOString() })
    : await store.create("quotations", { ...req.body, vendorId: vendor.id, organizationId: rfq.organizationId, status: req.body.status || "Submitted", createdAt: new Date().toISOString() });
  await activity("Quotation", `${vendor?.name || "Vendor"} ${previous ? "updated" : "submitted"} a quotation`, rfq.organizationId);
  res.status(previous ? 200 : 201).json({ ...quotation, ...quotationTotals(quotation) });
});

app.post("/api/approvals", auth, allow("Procurement Officer"), requireOrganization, async (req, res) => {
  const rfq = await store.get("rfqs", req.body.rfqId);
  if (!rfq || !sameOrganization(req.user, rfq)) return res.status(403).json({ message: "You can only start approvals for RFQs in your organization." });
  const approval = await store.create("approvals", {
    rfqId: req.body.rfqId,
    quotationId: req.body.quotationId,
    organizationId: req.user.organizationId,
    communityId: req.user.organizationId,
    status: "Pending L1",
    currentLevel: 1,
    remarks: "",
    timeline: [{ label: "Submitted", by: req.user.firstName + " " + req.user.lastName, date: new Date().toISOString(), state: "done" }, { label: "L1 Review", by: "Manager", date: null, state: "current" }, { label: "L2 Approval", by: "Finance", date: null, state: "upcoming" }, { label: "Generate PO", by: "System", date: null, state: "upcoming" }]
  });
  await activity("Approval", "Quotation selected and approval workflow initiated", req.user.organizationId);
  res.status(201).json(approval);
});

app.patch("/api/approvals/:id", auth, allow("Manager / Approver"), requireOrganization, async (req, res) => {
  const current = await store.get("approvals", req.params.id);
  if (!current) return res.status(404).json({ message: "Approval not found." });
  if (!sameOrganization(req.user, current)) return res.status(403).json({ message: "This approval belongs to another organization." });
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
    const po = await store.create("purchaseOrders", { number: `PO-${new Date().getFullYear()}-${String(pos.length + 68).padStart(4, "0")}`, quotationId: quotation.id, rfqId: quotation.rfqId, vendorId: quotation.vendorId, organizationId: current.organizationId, communityId: current.organizationId, status: "Approved", issueDate: new Date().toISOString().slice(0, 10), total: totals.total });
    const invoices = await store.list("invoices");
    const due = new Date(); due.setDate(due.getDate() + 30);
    const invoice = await store.create("invoices", { number: `INV-${new Date().getFullYear()}-${String(invoices.length + 149).padStart(4, "0")}`, poId: po.id, vendorId: po.vendorId, organizationId: current.organizationId, communityId: current.organizationId, issueDate: new Date().toISOString().slice(0, 10), dueDate: due.toISOString().slice(0, 10), status: "Pending Payment", ...totals });
    generated = { po, invoice };
    await activity("Purchase Order", `${po.number} and ${invoice.number} generated after approval`, current.organizationId);
  } else {
    await activity("Approval", `Procurement request ${status.toLowerCase()} by ${req.user.firstName} ${req.user.lastName}`, current.organizationId);
  }
  res.json({ approval, generated });
});

app.patch("/api/invoices/:id", auth, allow("Procurement Officer"), requireOrganization, async (req, res) => {
  const current = await store.get("invoices", req.params.id);
  if (!current) return res.status(404).json({ message: "Invoice not found." });
  if (!sameOrganization(req.user, current)) return res.status(403).json({ message: "This invoice belongs to another organization." });
  const invoice = await store.update("invoices", req.params.id, req.body);
  await activity("Invoice", `${invoice.number} status changed to ${invoice.status}`, req.user.organizationId);
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
  if (req.user.role === "Vendor") {
    if (invoice.vendorId !== req.user.vendorId || !sameOrganization(req.user, invoice)) {
      return res.status(403).json({ message: "This invoice belongs to another organization or vendor." });
    }
  } else if (req.user.role !== "Admin" && !sameOrganization(req.user, invoice)) {
    return res.status(403).json({ message: "This invoice belongs to another organization." });
  }
  invoicePdf(res, invoice, await store.get("vendors", invoice.vendorId), await store.get("purchaseOrders", invoice.poId));
});
app.post("/api/invoices/:id/email", auth, allow("Procurement Officer"), requireOrganization, async (req, res) => {
  const invoice = await store.get("invoices", req.params.id);
  if (!invoice) return res.status(404).json({ message: "Invoice not found." });
  if (!sameOrganization(req.user, invoice)) return res.status(403).json({ message: "This invoice belongs to another organization." });
  const vendor = await store.get("vendors", invoice.vendorId);
  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transporter.sendMail({ from: process.env.SMTP_USER, to: req.body.email || vendor.email, subject: `Invoice ${invoice.number}`, text: `Invoice ${invoice.number} for INR ${invoice.total.toLocaleString("en-IN")} is attached to your VendorBridge account.` });
  }
  await activity("Invoice", `${invoice.number} emailed to ${req.body.email || vendor.email}`, req.user.organizationId);
  res.json({ message: `Invoice sent to ${req.body.email || vendor.email}${process.env.SMTP_HOST ? "" : " (demo mode)"}.` });
});

app.get("/api/reports/export", auth, async (req, res) => {
  let { vendors, purchaseOrders, invoices } = await enriched();
  const organizationId = req.organizationId;
  if (req.user.role === "Procurement Officer" || req.user.role === "Manager / Approver" || (req.user.role === "Admin" && organizationId)) {
    vendors = scopeByOrganization(vendors, organizationId);
    purchaseOrders = scopeByOrganization(purchaseOrders, organizationId);
    invoices = scopeByOrganization(invoices, organizationId);
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
