APP_NAME: Bridge ERP Demo
APP_ID: com.example.bridge-erp-demo
NEXT_PORT: 3307
DAEMON_PORT: 7707
DATA_DIR_NAME: Bridge ERP Demo
PROJECT_MODE: new
DESIGN_SYSTEM: claude
ENTITY: purchase_request
ENTITY_PLURAL: purchase_requests
SUBPROCESS: codex-cli
MODULES:
  - purchasing
DOMAIN_BRIEF: >
  Demo ERP cloud/bridge with a generic purchasing module, anonymized demo data,
  supplier quotes, decision notes and agentic purchasing workflows.
ENTITIES:
  - name: supplier
    description: Demo supplier used by the purchasing module.
  - name: quote
    description: Supplier quote or offer attached to a purchase request.
METRICS:
  - Quotes waiting for review
  - Supplier response time
  - Estimated savings
SKILLS:
  - purchasing-analysis
AGENTIC_FIRST: true
MCP_ACTIONS:
  - purchasing.quote.import
  - purchasing.quote.analyze
