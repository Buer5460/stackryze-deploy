# GlobalStudy Public MVP — International Review

## 1. Product recap

GlobalStudy has evolved through these stages:

- **V0.5** — data foundation and school-search taxonomy
- **V1.0** — mobile school search, details, compare, shortlist, real-data import and review
- **V1.0.1** — verified-data governance, source rules, freshness and correction workflow
- **V1.1** — internal Growth Center for BD/sales/marketing, lead deduplication, scoring, outreach queue, opportunity and onboarding

The public international MVP intentionally does **not** expose the internal Growth Center, admin import tools, B2B commission data, internal CRM or operational controls.

## 2. Public positioning

**GlobalStudy is a global school discovery and education collaboration platform.**

The public MVP is designed for:
- Families and students
- Education agents
- Schools and education institutions
- Overseas partners and investors reviewing the product

## 3. What the public MVP includes

- English-first interface
- Chinese language toggle
- Responsive mobile + desktop layout
- Country / city / stage / curriculum search
- School result cards
- School detail view
- Up to four-school comparison
- Local shortlist
- Tuition / curriculum / language / boarding / scholarship / transit fields
- Source and verification status
- Explicit **Demo** vs **Verified** labels
- Product explanation for Families / Agents / Institutions
- Data-trust section

## 4. What the public MVP excludes

The public service returns 404 for:
- `/api/growth/*`
- `/api/admin/*`
- `/api/b2b/*`

The public interface does not expose:
- Growth Center
- Lead pool
- outreach queue
- admin import/review controls
- internal commissions
- internal CRM
- insurance-reserved architecture
- loans
- complex payments

## 5. Data trust rules

- Demo schools are synthetic and always marked as demo.
- Verified records must have a real source URL or accepted supplier evidence.
- Missing facts remain missing.
- AI must not invent school facts, rankings, commission terms or admission probability.
- Financial products are not enabled in the public MVP.

## 6. Public technical architecture

```text
International visitor
      ↓
globalstudy-world-mvp
      ↓
public-world/index.html
      ↓
server-public.js
      ↓
safe public API only
      ↓
existing verified/demo school data model
```

The existing internal service remains separate:

```text
Internal operations
      ↓
global-study-mobile-mvp
      ↓
C / B / S / Admin / Growth workflows
```

## 7. Public deployment

Render service:
- Name: `globalstudy-world-mvp`
- Branch: `global-study-mvp`
- Build: `npm install`
- Start: `npm run start:public`

Public URL:
- https://globalstudy-world-mvp.onrender.com

Internal product URL:
- https://global-study-mobile-mvp.onrender.com

## 8. Next product milestone

The next value milestone is **not more feature development**.

The next milestone is:
1. Import 20–50 verified Singapore schools.
2. Replace demo-only discovery with a mixed verified/demo dataset.
3. Let overseas users test search, detail, compare and shortlist.
4. Gather structured feedback from institutions, agents and families.
5. Only then decide whether to proceed to membership/payment features.
