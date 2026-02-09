# 12-Week Delivery Plan

> **Document**: 12-Week Plan v1.0
> **Status**: Draft
> **Last Updated**: 2026-02-08
> **Owner**: Product Team
> **Related Issues**: #28
> **Epics**: MVP-01 (#23-#28), MVP-02 (#29-#34), MVP-03 (#35-#40)

---

## Plan Overview

| Phase | Weeks | Epic | Theme | Key Outcome |
|---|---|---|---|---|
| 1 | 1-2 | MVP-01 | Foundation & Specs | Complete specification suite enabling parallel execution |
| 2 | 3-4 | MVP-02 | Security Foundation | RBAC, JWT hardening, authorization framework |
| 3 | 5-6 | MVP-02 + MVP-03 | Security Hardening + Platform Setup | Auth guards, security CI, dev environment |
| 4 | 7-8 | MVP-03 | Platform Infrastructure | Job queues, file storage, search |
| 5 | 9-10 | MVP-03 | Observability + Integration | CI/CD quality gates, monitoring stack |
| 6 | 11-12 | - | Stabilization + Launch | Integration testing, perf testing, launch readiness |

### Team Allocation Key

| Abbreviation | Team | Primary Members |
|---|---|---|
| **BE** | Backend | Services development (Express, business logic) |
| **FE** | Frontend | React application (apps/web) |
| **DATA** | Data | Database schema, migrations, Drizzle ORM |
| **PLAT** | Platform | Infrastructure, CI/CD, Docker, monitoring |
| **PROD** | Product | Specifications, requirements, acceptance criteria |

---

## Weeks 1-2: Foundation & Specifications (MVP-01)

**Epic**: MVP-01 Specifications
**Goal**: Complete specification suite that enables all subsequent parallel work streams

### Week 1

| Deliverable | Issues | Team | Status |
|---|---|---|---|
| Information architecture & screen inventory | #23 | PROD | Complete |
| Data model specification (40+ tables, 8 schemas) | #24 | PROD | Complete |
| Workflow & state machine specs | #25 | PROD | In Progress |
| API surface catalog (all service endpoints) | #26 | PROD | In Progress |

**Quality Gates**:
- All screen flows mapped with component hierarchy
- ER diagrams generated from Drizzle schema
- State machines defined for order, card, and user lifecycle

### Week 2

| Deliverable | Issues | Team | Status |
|---|---|---|---|
| Background job specifications | #27 | PROD | In Progress |
| NFR baseline, 12-week plan, dependency graph, risk register | #28 | PROD | In Progress |
| Spec review & approval from stakeholders | - | ALL | Pending |

**Quality Gates**:
- All 6 spec documents reviewed and approved
- NFR targets agreed upon by engineering leads
- 12-week plan ratified by all team leads
- Dependency graph validated (no circular dependencies, critical path confirmed)

**Risks**:
- Spec review may surface scope questions that delay approval
- Mitigation: Time-box review to 2 business days; unresolved items tracked as follow-up

---

## Weeks 3-4: Security Foundation (MVP-02)

**Epic**: MVP-02 Security (#29-#32)
**Goal**: Establish authorization framework that all subsequent features depend on

### Week 3

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| RBAC permission matrix | #29 | BE, DATA | Define all permissions for 7 roles across all resources; implement permission checking middleware |
| JWT token enhancements | #30 | BE | Refresh token rotation, token revocation list, secure cookie configuration |

**Team Allocation**:
- BE: RBAC middleware implementation, JWT refresh flow
- DATA: Permission tables schema, role-permission seed data
- FE: Auth context updates for new token flow
- PLAT: None (available for tech debt)

**Quality Gates**:
- Permission matrix document reviewed and approved
- JWT refresh flow passes integration tests (happy path + expired token + stolen token)
- All 7 roles have defined permission sets
- Existing tests still pass (regression check)

### Week 4

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| Auth guards (route-level) | #31 | BE | Express middleware enforcing role-based access on every route |
| RLS policy implementation | #32 | DATA | PostgreSQL row-level security policies for tenant isolation |

**Team Allocation**:
- BE: Auth guard middleware for all 6 services
- DATA: RLS policies on all tenant-scoped tables
- FE: Handle 403 responses gracefully (redirect, toast notification)
- PLAT: None (available for tech debt)

**Quality Gates**:
- Every route in every service has explicit auth guard (verified by route audit script)
- RLS policies active on all tenant-scoped tables
- Cross-tenant access test: authenticate as tenant A, attempt tenant B access, verify denial
- Auth guard integration tests for each role on representative endpoints
- Zero regression in existing test suite

**Risks**:
- RLS policies may cause performance regression on complex queries
- Mitigation: Benchmark critical queries before and after RLS; use composite indexes
- RBAC scope may expand if edge cases discovered in permission mapping
- Mitigation: Document "deferred decisions" for post-MVP resolution

---

## Weeks 5-6: Security Hardening + Platform Setup (MVP-02 + MVP-03)

**Epic**: MVP-02 (#33-#34), MVP-03 (#35)
**Goal**: Complete security hardening; bootstrap development environment

### Week 5

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| Service-level auth guards | #33 | BE | Service-to-service authentication (internal API calls between microservices) |
| Security audit CI pipeline | #34 | PLAT | OWASP ZAP scan, npm audit, route coverage check in GitHub Actions |

**Team Allocation**:
- BE: Service-to-service auth tokens, internal API authentication
- DATA: Query audit logging for security-sensitive operations
- FE: Security headers verification, CSP policy
- PLAT: GitHub Actions workflow for security scanning

**Quality Gates**:
- Service-to-service calls authenticated (no unauthenticated internal APIs)
- Security CI pipeline runs on every PR: npm audit, route audit, OWASP ZAP baseline
- Zero critical/high findings from initial security scan
- Security audit report generated and reviewed

### Week 6

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| Dev environment bootstrap | #35 | PLAT | One-command local development setup: `npm run dev:bootstrap` — Docker Compose, seed data, env config |

**Team Allocation**:
- BE: Seed data generation scripts for all services
- DATA: Sample dataset (multi-tenant, realistic volumes)
- FE: Storybook setup for component development
- PLAT: Docker Compose enhancements, bootstrap script, documentation

**Quality Gates**:
- New developer can go from `git clone` to running app in < 10 minutes
- Seed data covers all 7 user roles, 3+ tenants, all billing plans
- `npm run dev:bootstrap` works on macOS and Linux
- README updated with development quickstart guide

**Risks**:
- OWASP ZAP scan may produce false positives blocking CI pipeline
- Mitigation: Maintain allowlist file for known false positives; review weekly
- Docker Compose for dev may conflict with production Docker config
- Mitigation: Separate `docker-compose.dev.yml` with clear documentation

**Gateway Milestone**: SECURITY COMPLETE
- All MVP-02 issues (#29-#34) closed
- Security audit CI green
- Proceed/no-proceed decision for platform work

---

## Weeks 7-8: Platform Infrastructure (MVP-03)

**Epic**: MVP-03 (#36-#38)
**Goal**: Build infrastructure services that features depend on

### Week 7

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| Job queue system (BullMQ) | #36 | BE, PLAT | BullMQ workers for background processing; dashboard for monitoring; job patterns: ReLoWiSa recalc, order aging, stale card cleanup |

**Team Allocation**:
- BE: BullMQ worker implementations for 6 job types (from #27 spec)
- DATA: Job result storage schema
- FE: Bull Board dashboard integration (admin-only route)
- PLAT: Redis configuration for BullMQ; worker process management

**Quality Gates**:
- All 6 job types implemented with tests: ReLoWiSa recalc, order aging/escalation, stale card cleanup, report generation, notification digest, data export
- Job retry logic tested (3 retries with exponential backoff)
- Dead letter queue configured for failed jobs
- Bull Board accessible at admin route

### Week 8

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| File storage (S3/MinIO) | #37 | BE, PLAT | Upload/download service with signed URLs; MinIO for local dev, S3 for production |
| Search service (Elasticsearch) | #38 | BE, PLAT | Catalog and order search with faceted filtering |

**Team Allocation**:
- BE (team A): File upload/download endpoints, signed URL generation
- BE (team B): Elasticsearch indexing and query service
- DATA: Search index mappings for catalog and orders
- FE: File upload component; search UI with filters
- PLAT: MinIO Docker setup; Elasticsearch Docker setup; S3 IAM configuration

**Quality Gates**:
- File upload/download works for images (< 10MB) and documents (< 50MB)
- Signed URLs expire correctly (15min default)
- Search returns relevant results with < 200ms latency
- Search indexes stay in sync with database (event-driven indexing)
- All new endpoints have auth guards and tenant isolation

**Risks**:
- Elasticsearch operational complexity may exceed team capacity
- Mitigation: Evaluate PostgreSQL full-text search as simpler alternative; decision by Week 7 Day 1
- S3/MinIO configuration differences between dev and production
- Mitigation: Abstract behind storage interface; environment-specific config

---

## Weeks 9-10: Observability + Integration (MVP-03)

**Epic**: MVP-03 (#39-#40)
**Goal**: Production-grade observability and CI/CD quality gates

### Week 9

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| CI/CD quality gates | #39 | PLAT | PR checks: lint, type-check, test, security scan, Lighthouse CI, coverage thresholds |

**Team Allocation**:
- BE: Test coverage improvements to meet thresholds (target: 60% line coverage)
- DATA: Migration safety checks in CI (no destructive migrations without review)
- FE: Lighthouse CI integration; visual regression setup
- PLAT: GitHub Actions workflow enhancements; branch protection rules

**Quality Gates**:
- All PRs require: lint pass, type-check pass, tests pass, npm audit pass
- Test coverage reported on every PR (no merge below threshold)
- Lighthouse CI blocks merge if performance regresses > 10%
- Migration safety: destructive operations require manual approval label

### Week 10

| Deliverable | Issues | Team | Description |
|---|---|---|---|
| Monitoring stack (Sentry + Prometheus + Grafana) | #40 | PLAT, BE | Error tracking, metrics collection, dashboarding |

**Team Allocation**:
- BE: Sentry SDK integration in all 6 services; Prometheus metrics endpoints
- FE: Sentry SDK integration in React app; performance monitoring
- PLAT: Grafana dashboard setup; alerting rules; uptime monitoring

**Quality Gates**:
- Sentry captures errors from all services and frontend with full context
- Prometheus scrapes metrics from all services every 15s
- Grafana dashboards: service health, request latency, error rates, queue depth
- Alerts configured: error rate spike, latency degradation, service down
- NFR-OBS-001 through NFR-OBS-004 validated

**Risks**:
- Test coverage targets may be ambitious given current 20-test baseline
- Mitigation: Focus coverage on critical paths first; gradually increase thresholds
- Monitoring stack adds operational overhead
- Mitigation: Use managed services where possible (Sentry SaaS, Railway metrics)

**Gateway Milestone**: PLATFORM COMPLETE
- All MVP-03 issues (#35-#40) closed
- Monitoring dashboards operational
- All NFR targets measurable via tooling

---

## Weeks 11-12: Stabilization + Launch Prep

**Epic**: None (stabilization sprint)
**Goal**: Validate system quality; prepare for production launch

### Week 11

| Deliverable | Team | Description |
|---|---|---|
| Integration test suite | BE, FE | End-to-end tests covering all critical user flows across services |
| Performance test suite | PLAT | k6 load tests validating NFR-PERF targets |
| Security audit | PLAT | Full OWASP ZAP scan; dependency audit; penetration test on auth flows |

**Team Allocation**:
- BE: Integration tests for cross-service flows (order lifecycle, kanban updates, notifications)
- FE: Cypress/Playwright E2E tests for critical user journeys
- DATA: Data integrity verification scripts; backup/restore drill
- PLAT: k6 load test scripts; security audit execution

**Quality Gates**:
- Integration tests cover: user registration, order creation through fulfillment, kanban card lifecycle, notification delivery
- Load test passes all NFR-PERF targets under expected load
- Security audit: zero critical findings, zero high findings
- Backup restore drill successful with < 5 min RPO verified

### Week 12

| Deliverable | Team | Description |
|---|---|---|
| Documentation finalization | ALL | API docs, runbooks, architecture decision records |
| Launch readiness review | ALL | Go/no-go checklist with stakeholder sign-off |
| Performance optimization | BE, FE | Address any NFR violations found in Week 11 |
| Production environment validation | PLAT | Staging environment mirrors production; smoke test suite |

**Team Allocation**:
- BE: Fix any integration test failures; optimize slow endpoints
- FE: Fix any E2E test failures; optimize bundle size and LCP
- DATA: Verify production database configuration; connection pool tuning
- PLAT: Production environment checklist; DNS, SSL, CDN configuration
- PROD: Launch readiness document; stakeholder presentation

**Quality Gates (Launch Readiness Checklist)**:
- [ ] All NFR targets met (performance, reliability, security, accessibility)
- [ ] Zero critical/high bugs in issue tracker
- [ ] All integration tests passing
- [ ] Security audit clean (zero critical/high)
- [ ] Monitoring dashboards operational with alerts configured
- [ ] Runbooks documented for common failure scenarios
- [ ] Backup/restore procedure tested
- [ ] Rollback procedure documented and tested
- [ ] On-call rotation established
- [ ] Stakeholder sign-off obtained

**Risks**:
- Week 11 testing may reveal systemic issues requiring significant rework
- Mitigation: Continuous integration testing throughout Weeks 3-10 (not just Week 11)
- Launch date pressure may lead to skipping quality gates
- Mitigation: Launch readiness checklist is non-negotiable; defer launch rather than skip

---

## Weekly Cadence

Every week follows this rhythm:

| Day | Activity |
|---|---|
| Monday | Sprint planning; review previous week's quality gates |
| Tuesday-Thursday | Development & implementation |
| Friday | Demo, code review, retrospective, quality gate verification |

## Escalation Triggers

Escalate to project lead immediately if:
- Any quality gate fails for 2+ consecutive days
- Critical security finding discovered
- Team member unavailable for 3+ days
- Scope change requested that affects critical path
- Dependency on external service/vendor is blocked

---

## Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-02-08 | Product Lane Agent | Initial plan |
