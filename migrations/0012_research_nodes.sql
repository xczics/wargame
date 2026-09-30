-- research: tech nodes registered at runtime (e.g. discoveries of the opaque tech plugin).
-- `def` is the JSON of a data-only TechDef. owner_id NULL = visible to everyone.
CREATE TABLE research_nodes (
	id TEXT PRIMARY KEY,
	owner_id TEXT,
	def TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX research_nodes_owner ON research_nodes (owner_id);
