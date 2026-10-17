'use strict';
// ---------------------------------------------------------------------------
// Unified Supplier model — one system for all six supplier types.
//
// A Supplier is an Organization of kind S. Type-specific behaviour lives in
// SupplierProfile.extensions, never in six separate copies of the system.
// ---------------------------------------------------------------------------
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const org = require('./org');
const { id, iso, today, lower, clone, asNumber, truthy } = require('./util');
const audit = require('./audit');

const suppliers = () => db.stores.suppliers;
const profiles = () => db.stores.supplier_profiles;

const VERIFICATION_STATES = ['draft', 'pending', 'verified', 'rejected', 'expired'];

function createSupplier(input, actor) {
  const type = String(input.type || 'EDUCATION').toUpperCase();
  if (!auth.SUPPLIER_TYPES[type]) throw new Error('未知供应商类型: ' + input.type);
  const organization = org.createOrganization({
    kind: 'S',
    name: input.name,
    name_en: input.name_en || null,
    country: input.country || null,
    city: input.city || null,
    contact_name: input.contact_name || null,
    contact_email: input.contact_email || null,
    contact_phone: input.contact_phone || null,
    is_demo: Boolean(input.is_demo),
    kyc_status: input.kyc_status || 'pending',
    kyb_status: input.kyb_status || 'pending'
  }, actor);

  const record = {
    id: id('supplier'),
    organization_id: organization.id,
    type,
    name: input.name,
    name_en: input.name_en || null,
    verification: input.verification || 'pending',
    verified_at: null,
    verified_by: null,
    is_demo: Boolean(input.is_demo),
    source_url: input.source_url || null,
    supplier_evidence: input.supplier_evidence || null,
    effective_from: input.effective_from || iso(),
    effective_to: input.effective_to || null,
    status: input.status || 'active',
    public_visible: truthy(input.public_visible),
    accepts_b_orders: input.accepts_b_orders === undefined ? true : truthy(input.accepts_b_orders),
    created_at: iso(),
    updated_at: iso()
  };
  const saved = suppliers().insert(record);

  const profile = createProfile(saved.id, input.profile || {}, actor);
  audit.record({ actor, action: 'supplier:create', entity: 'supplier', entity_id: saved.id, to: { type, verification: saved.verification } });
  return { supplier: saved, profile };
}

function createProfile(supplierId, input, actor) {
  const base = {
    id: id('supplier_profile'),
    supplier_id: supplierId,
    description: input.description || null,
    description_en: input.description_en || null,
    languages: input.languages || [],
    service_countries: input.service_countries || [],
    service_cities: input.service_cities || [],
    // Contact channels are PRIVATE. C never sees them (Rule 8).
    contact_phone: input.contact_phone || null,
    contact_email: input.contact_email || null,
    contact_whatsapp: input.contact_whatsapp || null,
    media: input.media || [],
    qualifications: input.qualifications || [],
    extensions: {}
  };

  // Type-specific extension fields.
  const type = lower(suppliers().byId(supplierId) ? suppliers().byId(supplierId).type : 'EDUCATION');
  if (type === 'education') {
    base.extensions = {
      institution_type: input.institution_type || null,
      campuses: input.campuses || [],
      facilities: input.facilities || [],
      teachers: input.teachers || [],
      virtual_tour_url: input.virtual_tour_url || null,
      video_url: input.video_url || null,
      admission_workflow: input.admission_workflow || DEFAULT_ADMISSION_WORKFLOW
    };
  } else if (type === 'accommodation') {
    base.extensions = {
      accommodation_types: input.accommodation_types || [],
      room_types: input.room_types || [],
      guardian_services: input.guardian_services || [],
      school_partnerships: input.school_partnerships || [],
      agency_partnerships: input.agency_partnerships || []
    };
  } else if (type === 'medical') {
    base.extensions = {
      // MVP stores no medical diagnosis: only appointment / status / files.
      medical_capabilities: input.medical_capabilities || [],
      stores_diagnosis: false
    };
  } else if (type === 'certification') {
    base.extensions = { certification_types: input.certification_types || [] };
  } else if (type === 'visa') {
    base.extensions = { visa_types: input.visa_types || [], target_countries: input.target_countries || [] };
  } else if (type === 'finance') {
    base.extensions = {
      products: input.products || [],
      // Compliance boundary: no credit scoring / approval / disbursement.
      credit_scoring_enabled: false,
      auto_approval_enabled: false,
      disbursement_enabled: false
    };
  }

  const saved = profiles().insert(base);
  audit.record({ actor, action: 'supplier_profile:create', entity: 'supplier', entity_id: supplierId, to: { profile_id: saved.id } });
  return saved;
}

const DEFAULT_ADMISSION_WORKFLOW = [
  'received', 'documents_review', 'additional_documents', 'interview_required',
  'interview_scheduled', 'interview_complete', 'under_review', 'admitted',
  'waitlisted', 'rejected', 'confirmed', 'deposit_paid', 'enrolled', 'withdrawn'
];

function updateProfile(supplierId, patch, actor) {
  const p = profileOfSupplier(supplierId);
  if (!p) return null;
  const before = clone(p);
  Object.assign(p, patch);
  if (patch.extensions) p.extensions = { ...p.extensions, ...patch.extensions };
  audit.record({ actor, action: 'supplier_profile:update', entity: 'supplier', entity_id: supplierId, from: before, to: p });
  return p;
}

function profileOfSupplier(supplierId) {
  return profiles().find((p) => String(p.supplier_id) === String(supplierId)) || null;
}

function supplierById(supplierId) { return suppliers().byId(supplierId); }

function listSuppliers(filters = {}) {
  let items = suppliers().all();
  if (filters.type) items = items.filter((s) => lower(s.type) === lower(filters.type));
  if (filters.verification) items = items.filter((s) => lower(s.verification) === lower(filters.verification));
  if (filters.public_visible !== undefined) items = items.filter((s) => Boolean(s.public_visible) === Boolean(filters.public_visible));
  if (filters.is_demo !== undefined) items = items.filter((s) => Boolean(s.is_demo) === Boolean(filters.is_demo));
  if (filters.q) {
    const q = lower(filters.q);
    items = items.filter((s) => lower(s.name).includes(q) || lower(s.name_en || '').includes(q));
  }
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// Public view: demo labelling + no private contact channels (Rule 8/20).
function publicView(supplier) {
  if (!supplier) return null;
  const profile = profileOfSupplier(supplier.id);
  return {
    id: supplier.id,
    type: supplier.type,
    name: supplier.name,
    name_en: supplier.name_en || null,
    location: { country: profile ? profile.service_countries : [] },
    verification: {
      status: supplier.verification,
      is_demo: Boolean(supplier.is_demo),
      verified_at: supplier.verified_at,
      source_url: supplier.source_url || null,
      effective_from: supplier.effective_from,
      effective_to: supplier.effective_to
    },
    profile: profile ? {
      description: profile.description,
      description_en: profile.description_en,
      languages: profile.languages,
      service_countries: profile.service_countries,
      service_cities: profile.service_cities,
      media: profile.media,
      extensions: publicExtensions(supplier.type, profile.extensions)
    } : null
  };
}

function publicExtensions(type, extensions) {
  const out = { ...(extensions || {}) };
  // Finance: entry may exist but the feature is off by default (Rule S6).
  if (lower(type) === 'finance' && !config.financeEnabled()) {
    return { coming_soon: true, note: '功能暂未开放 / Coming soon' };
  }
  return out;
}

// B-side view: cooperation conditions, agreement status, commission rules.
function bView(supplier) {
  if (!supplier) return null;
  const contracts = require('./contracts');
  const agreements = contracts.listAgreements({ supplier_id: supplier.id });
  const realAgreements = agreements.filter((a) => !a.is_demo);
  const profile = profileOfSupplier(supplier.id);
  return {
    ...publicView(supplier),
    cooperation: {
      accepts_b_orders: supplier.accepts_b_orders,
      agreement_status: realAgreements.length ? 'active' : agreements.length ? 'demo' : 'none',
      agreements: realAgreements.map((a) => ({ id: a.id, kind: a.kind, status: a.status, state: a.state })),
      commission_rules: realAgreements.length
        ? realAgreements.flatMap((a) => contracts.listCommissionRules({ agreement_id: a.id }).map((r) => ({
            id: r.id, mode: r.mode, value: r.value, currency: r.currency, trigger_event: r.trigger_event,
            settlement_cycle_days: r.settlement_cycle_days
          })))
        : [],
      commission_note: realAgreements.length ? null : (agreements.length ? '暂无真实合作协议' : '暂无合作协议')
    },
    // B-only contact channels (never exposed to C).
    contact: profile ? {
      phone: profile.contact_phone,
      email: profile.contact_email,
      whatsapp: profile.contact_whatsapp
    } : null
  };
}

// ---------------------------------------------------------------------------
// Verification (Rule 20)
// ---------------------------------------------------------------------------
function verifySupplier(supplierId, decision, actor) {
  const supplier = suppliers().byId(supplierId);
  if (!supplier) return { ok: false, error: '供应商不存在' };
  const target = lower(decision) === 'approve' ? 'verified' : lower(decision) === 'reject' ? 'rejected' : lower(decision) === 'expire' ? 'expired' : null;
  if (!target) return { ok: false, error: 'decision 应为 approve / reject / expire' };

  if (target === 'verified') {
    const requiresSource = config.get('verified_requires_source', true);
    if (requiresSource && !supplier.source_url && !supplier.supplier_evidence) {
      return { ok: false, error: '缺少来源（source_url / supplier_evidence）不能核验通过' };
    }
  }
  const from = supplier.verification;
  supplier.verification = target;
  supplier.verified_at = target === 'verified' ? (supplier.verified_at || iso()) : null;
  supplier.verified_by = target === 'verified' ? (actor && actor.id) : null;
  supplier.updated_at = iso();
  audit.record({ actor, action: 'supplier:verify', entity: 'supplier', entity_id: supplier.id, from, to: supplier.verification });
  return { ok: true, supplier };
}

module.exports = {
  VERIFICATION_STATES, DEFAULT_ADMISSION_WORKFLOW,
  createSupplier, createProfile, updateProfile, profileOfSupplier,
  supplierById, listSuppliers, publicView, bView, verifySupplier
};
