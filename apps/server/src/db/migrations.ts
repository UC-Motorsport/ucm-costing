export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: PostgresMigration[] = [
  {
    version: 1,
    name: "postgres production baseline",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE app_metadata (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE source_documents (
        id text PRIMARY KEY,
        kind text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        original_url text NOT NULL,
        local_path text NOT NULL,
        sha256 char(64) NOT NULL UNIQUE
          CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        applicability text NOT NULL,
        retrieved_at timestamptz NOT NULL
      );

      CREATE TABLE catalogue_releases (
        id text PRIMARY KEY,
        competition_year integer NOT NULL CHECK (competition_year >= 2020),
        revision_code text NOT NULL,
        released_on date,
        source_document_id text NOT NULL
          REFERENCES source_documents(id),
        imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (competition_year, revision_code, source_document_id)
      );

      CREATE INDEX catalogue_releases_source_document_idx
        ON catalogue_releases(source_document_id);

      CREATE TABLE catalogue_items (
        id text PRIMARY KEY,
        release_id text NOT NULL REFERENCES catalogue_releases(id),
        kind text NOT NULL CHECK (kind IN (
          'material', 'process', 'multiplier', 'fastener', 'tooling', 'stock-size'
        )),
        catalogue_id text NOT NULL,
        name text NOT NULL,
        category text,
        supplier text,
        unit text,
        unit_2 text,
        raw_formula text,
        fixed_cost numeric CHECK (fixed_cost IS NULL OR fixed_cost >= 0),
        coefficients_json jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(coefficients_json) = 'object'),
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(metadata_json) = 'object'),
        source_sheet text NOT NULL,
        source_row integer NOT NULL CHECK (source_row > 0),
        raw_json jsonb NOT NULL
          CHECK (jsonb_typeof(raw_json) = 'object'),
        UNIQUE (id, release_id),
        UNIQUE (release_id, kind, catalogue_id)
      );

      CREATE INDEX catalogue_items_release_kind_name_idx
        ON catalogue_items(release_id, kind, name);
      CREATE INDEX catalogue_items_name_trgm_idx
        ON catalogue_items USING gin(name gin_trgm_ops);
      CREATE INDEX catalogue_items_catalogue_id_trgm_idx
        ON catalogue_items USING gin(catalogue_id gin_trgm_ops);

      CREATE TABLE users (
        id text PRIMARY KEY,
        email text NOT NULL CHECK (btrim(email) <> ''),
        display_name text NOT NULL CHECK (btrim(display_name) <> ''),
        password_hash text,
        role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        CHECK (status <> 'active' OR password_hash IS NOT NULL)
      );

      CREATE UNIQUE INDEX users_email_lower_unique
        ON users(lower(email));

      CREATE TABLE user_invites (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_digest char(64) NOT NULL UNIQUE
          CHECK (token_digest ~ '^[0-9a-f]{64}$'),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_by text NOT NULL REFERENCES users(id)
      );

      CREATE INDEX user_invites_user_id_idx ON user_invites(user_id);
      CREATE INDEX user_invites_active_expiry_idx
        ON user_invites(expires_at)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;

      CREATE TABLE sessions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_digest char(64) NOT NULL UNIQUE
          CHECK (token_digest ~ '^[0-9a-f]{64}$'),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        revoked_at timestamptz,
        user_agent text,
        ip_address_hash text
      );

      CREATE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX sessions_active_expiry_idx
        ON sessions(expires_at)
        WHERE revoked_at IS NULL;

      CREATE TABLE projects (
        id text PRIMARY KEY,
        name text NOT NULL CHECK (btrim(name) <> ''),
        season integer NOT NULL CHECK (season >= 2020),
        vehicle_type text NOT NULL
          CHECK (vehicle_type IN ('electric', 'combustion', 'dual')),
        entry_number text NOT NULL CHECK (btrim(entry_number) <> ''),
        status text NOT NULL CHECK (status IN ('draft', 'review', 'submitted')),
        rule_pack_version text NOT NULL,
        rule_pack_sha256 char(64) NOT NULL
          CHECK (rule_pack_sha256 ~ '^[0-9a-f]{64}$'),
        rule_source_document_id text NOT NULL REFERENCES source_documents(id),
        catalogue_release_id text NOT NULL REFERENCES catalogue_releases(id),
        cost_model text NOT NULL DEFAULT 'competition-universal-dollar'
          CHECK (cost_model = 'competition-universal-dollar'),
        project_summary text NOT NULL DEFAULT '',
        numbering_convention text NOT NULL DEFAULT '',
        bulk_method_summary text NOT NULL DEFAULT '',
        focus_systems_json jsonb NOT NULL DEFAULT '["DR"]'::jsonb
          CHECK (jsonb_typeof(focus_systems_json) = 'array'),
        archived_at timestamptz,
        created_by text REFERENCES users(id),
        updated_by text REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
      );

      CREATE INDEX projects_catalogue_release_id_idx
        ON projects(catalogue_release_id);
      CREATE INDEX projects_rule_source_document_id_idx
        ON projects(rule_source_document_id);
      CREATE INDEX projects_created_by_idx ON projects(created_by);
      CREATE INDEX projects_updated_by_idx ON projects(updated_by);
      CREATE INDEX projects_active_sort_idx
        ON projects(season DESC, name, id)
        WHERE archived_at IS NULL;

      CREATE TABLE project_memberships (
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        created_by text NOT NULL REFERENCES users(id),
        PRIMARY KEY (project_id, user_id)
      );

      CREATE INDEX project_memberships_user_id_idx
        ON project_memberships(user_id, project_id);
      CREATE INDEX project_memberships_created_by_idx
        ON project_memberships(created_by);

      CREATE TABLE import_batches (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        template text NOT NULL,
        source_name text NOT NULL,
        source_sha256 char(64) NOT NULL
          CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        source_encoding text NOT NULL,
        source_blob_path text,
        status text NOT NULL
          CHECK (status IN ('preview', 'committed', 'cancelled')),
        preview_json jsonb NOT NULL,
        committed_at timestamptz,
        cancelled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        created_by text REFERENCES users(id),
        committed_by text REFERENCES users(id),
        cancelled_by text REFERENCES users(id),
        idempotency_key text,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        UNIQUE (project_id, idempotency_key)
      );

      CREATE INDEX import_batches_project_created_idx
        ON import_batches(project_id, created_at DESC, id);
      CREATE INDEX import_batches_created_by_idx ON import_batches(created_by);
      CREATE INDEX import_batches_committed_by_idx ON import_batches(committed_by);
      CREATE INDEX import_batches_cancelled_by_idx ON import_batches(cancelled_by);

      CREATE TABLE cost_nodes (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id text REFERENCES cost_nodes(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN (
          'vehicle', 'system', 'assembly', 'subassembly', 'part'
        )),
        system_code text,
        raw_hla text,
        raw_subassembly text,
        raw_part_number text,
        reference_id text,
        full_number text,
        name text NOT NULL CHECK (btrim(name) <> ''),
        description text NOT NULL DEFAULT '',
        revision text,
        procurement_type text NOT NULL DEFAULT 'unknown'
          CHECK (procurement_type IN ('made', 'bought', 'unknown')),
        quantity numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
        internal_note text NOT NULL DEFAULT '',
        source_import_batch_id text REFERENCES import_batches(id),
        source_import_row integer,
        sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX cost_nodes_tree_idx
        ON cost_nodes(project_id, parent_id, sort_order, id);
      CREATE INDEX cost_nodes_parent_id_idx ON cost_nodes(parent_id);
      CREATE INDEX cost_nodes_source_import_batch_id_idx
        ON cost_nodes(source_import_batch_id);
      CREATE UNIQUE INDEX cost_nodes_full_number_lower_unique
        ON cost_nodes(project_id, lower(full_number))
        WHERE full_number IS NOT NULL;
      CREATE UNIQUE INDEX cost_nodes_vehicle_root_unique
        ON cost_nodes(project_id)
        WHERE kind = 'vehicle';
      CREATE UNIQUE INDEX cost_nodes_system_code_lower_unique
        ON cost_nodes(project_id, lower(system_code))
        WHERE kind = 'system' AND system_code IS NOT NULL;

      CREATE TABLE cost_lines (
        id text PRIMARY KEY,
        node_id text NOT NULL REFERENCES cost_nodes(id) ON DELETE CASCADE,
        kind text NOT NULL
          CHECK (kind IN ('material', 'process', 'fastener', 'tooling')),
        catalogue_item_id text REFERENCES catalogue_items(id),
        description text NOT NULL CHECK (btrim(description) <> ''),
        use_description text NOT NULL DEFAULT '',
        unit_cost numeric NOT NULL CHECK (unit_cost >= 0),
        quantity numeric NOT NULL CHECK (quantity > 0),
        multiplier numeric NOT NULL DEFAULT 1 CHECK (multiplier > 0),
        multiplier_name text,
        multiplier_catalogue_item_id text REFERENCES catalogue_items(id),
        fraction_included numeric NOT NULL DEFAULT 1
          CHECK (fraction_included > 0 AND fraction_included <= 1),
        production_volume_factor numeric
          CHECK (production_volume_factor IS NULL OR production_volume_factor > 0),
        size_inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(size_inputs_json) = 'object'),
        calculation_json jsonb NOT NULL
          CHECK (jsonb_typeof(calculation_json) = 'object'),
        subtotal numeric NOT NULL CHECK (subtotal >= 0),
        sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX cost_lines_node_kind_sort_idx
        ON cost_lines(node_id, kind, sort_order, id);
      CREATE INDEX cost_lines_catalogue_item_id_idx
        ON cost_lines(catalogue_item_id);
      CREATE INDEX cost_lines_multiplier_catalogue_item_id_idx
        ON cost_lines(multiplier_catalogue_item_id);

      CREATE TABLE evidence (
        id text PRIMARY KEY,
        node_id text REFERENCES cost_nodes(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN (
          'drawing', 'image', 'datasheet', 'manufacturing', 'bulk-deviation', 'other'
        )),
        display_name text NOT NULL CHECK (btrim(display_name) <> ''),
        content_sha256 char(64) NOT NULL
          CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        storage_path text NOT NULL UNIQUE,
        mime_type text NOT NULL,
        visibility text NOT NULL DEFAULT 'internal'
          CHECK (visibility IN ('internal', 'report')),
        report_caption text NOT NULL DEFAULT '',
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX evidence_project_created_idx
        ON evidence(project_id, created_at DESC, id);
      CREATE INDEX evidence_node_id_idx ON evidence(node_id);

      CREATE TABLE import_rows (
        id text PRIMARY KEY,
        batch_id text NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        row_number integer NOT NULL CHECK (row_number > 0),
        raw_json jsonb NOT NULL,
        candidate_json jsonb,
        outcome text NOT NULL DEFAULT 'preview'
          CHECK (outcome IN ('preview', 'committed', 'skipped')),
        node_id text REFERENCES cost_nodes(id) ON DELETE SET NULL,
        UNIQUE (batch_id, row_number)
      );

      CREATE INDEX import_rows_node_id_idx ON import_rows(node_id);

      CREATE TABLE import_issues (
        id text PRIMARY KEY,
        batch_id text NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        severity text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
        code text NOT NULL,
        message text NOT NULL,
        row_number integer,
        field text,
        issue_json jsonb NOT NULL
      );

      CREATE INDEX import_issues_batch_id_idx ON import_issues(batch_id);

      CREATE TABLE report_snapshots (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id),
        mode text NOT NULL CHECK (mode IN ('draft', 'competition-ready')),
        status text NOT NULL
          CHECK (status IN ('rendering', 'complete', 'failed')),
        snapshot_json jsonb NOT NULL,
        validation_json jsonb NOT NULL,
        source_hashes_json jsonb NOT NULL,
        pdf_path text,
        pdf_sha256 char(64)
          CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_bytes bigint CHECK (pdf_bytes IS NULL OR pdf_bytes >= 0),
        page_count integer CHECK (page_count IS NULL OR page_count > 0),
        created_by text NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        error_message text,
        render_owner text,
        render_heartbeat_at timestamptz
      );

      CREATE INDEX report_snapshots_project_created_idx
        ON report_snapshots(project_id, created_at DESC, id);
      CREATE INDEX report_snapshots_created_by_idx
        ON report_snapshots(created_by, created_at DESC, id);
      CREATE INDEX report_snapshots_render_lease_idx
        ON report_snapshots(render_heartbeat_at, id)
        WHERE status = 'rendering';

      CREATE TABLE project_setup_confirmations (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        project_version integer NOT NULL CHECK (project_version >= 0),
        setup_json jsonb NOT NULL
          CHECK (jsonb_typeof(setup_json) = 'object'),
        content_hash char(64) NOT NULL
          CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        confirmed_by text NOT NULL REFERENCES users(id),
        confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        invalidated_at timestamptz,
        invalidated_by text REFERENCES users(id),
        invalidation_reason text
      );

      CREATE INDEX project_setup_confirmations_project_idx
        ON project_setup_confirmations(project_id, confirmed_at DESC, id);
      CREATE INDEX project_setup_confirmations_confirmed_by_idx
        ON project_setup_confirmations(confirmed_by);
      CREATE INDEX project_setup_confirmations_invalidated_by_idx
        ON project_setup_confirmations(invalidated_by);
      CREATE UNIQUE INDEX project_setup_confirmations_active_unique
        ON project_setup_confirmations(project_id)
        WHERE invalidated_at IS NULL;

      CREATE TABLE evidence_file_cleanup (
        storage_path text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id),
        reason text NOT NULL CHECK (reason IN (
          'replacement', 'deletion', 'staged-file'
        )),
        queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_attempt_at timestamptz,
        last_error text,
        lease_owner text,
        lease_expires_at timestamptz
      );

      CREATE INDEX evidence_file_cleanup_project_id_idx
        ON evidence_file_cleanup(project_id);
      CREATE INDEX evidence_file_cleanup_claim_idx
        ON evidence_file_cleanup(queued_at, storage_path)
        WHERE lease_owner IS NULL;
      CREATE INDEX evidence_file_cleanup_lease_expiry_idx
        ON evidence_file_cleanup(lease_expires_at)
        WHERE lease_owner IS NOT NULL;

      CREATE TABLE cair_requests (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        cost_line_id text REFERENCES cost_lines(id) ON DELETE SET NULL,
        status text NOT NULL
          CHECK (status IN (
            'draft', 'submitted', 'catalogue-resolved', 'rejected', 'cancelled'
          )),
        requested_catalogue_description text NOT NULL,
        rationale text NOT NULL,
        proposed_cost numeric CHECK (proposed_cost IS NULL OR proposed_cost >= 0),
        provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        external_reference text,
        decision_note text,
        resolved_catalogue_release_id text
          REFERENCES catalogue_releases(id),
        resolved_catalogue_item_id text,
        created_by text NOT NULL REFERENCES users(id),
        updated_by text NOT NULL REFERENCES users(id),
        decided_by text REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        submitted_at timestamptz,
        decided_at timestamptz,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        FOREIGN KEY (
          resolved_catalogue_item_id, resolved_catalogue_release_id
        ) REFERENCES catalogue_items(id, release_id),
        CHECK (
          (
            status = 'catalogue-resolved'
            AND resolved_catalogue_release_id IS NOT NULL
            AND resolved_catalogue_item_id IS NOT NULL
          )
          OR (
            status <> 'catalogue-resolved'
            AND resolved_catalogue_release_id IS NULL
            AND resolved_catalogue_item_id IS NULL
          )
        )
      );

      CREATE INDEX cair_requests_project_status_idx
        ON cair_requests(project_id, status, updated_at DESC, id);
      CREATE INDEX cair_requests_cost_line_id_idx ON cair_requests(cost_line_id);
      CREATE INDEX cair_requests_resolved_release_id_idx
        ON cair_requests(resolved_catalogue_release_id);
      CREATE INDEX cair_requests_resolved_item_id_idx
        ON cair_requests(resolved_catalogue_item_id);
      CREATE INDEX cair_requests_created_by_idx ON cair_requests(created_by);
      CREATE INDEX cair_requests_updated_by_idx ON cair_requests(updated_by);
      CREATE INDEX cair_requests_decided_by_idx ON cair_requests(decided_by);

      CREATE TABLE cair_evidence (
        cair_id text NOT NULL REFERENCES cair_requests(id) ON DELETE CASCADE,
        evidence_id text NOT NULL REFERENCES evidence(id),
        PRIMARY KEY (cair_id, evidence_id)
      );

      CREATE INDEX cair_evidence_evidence_id_idx
        ON cair_evidence(evidence_id);

      CREATE TABLE cost_amendments (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_reference text NOT NULL,
        status text NOT NULL CHECK (status IN (
          'draft', 'locked', 'exported', 'manually-submitted', 'accepted', 'rejected'
        )),
        base_report_snapshot_id text NOT NULL REFERENCES report_snapshots(id),
        snapshot_json jsonb,
        total_additions numeric NOT NULL DEFAULT 0 CHECK (total_additions >= 0),
        total_removals numeric NOT NULL DEFAULT 0 CHECK (total_removals >= 0),
        net_change numeric NOT NULL DEFAULT 0,
        external_reference text,
        created_by text NOT NULL REFERENCES users(id),
        updated_by text NOT NULL REFERENCES users(id),
        locked_by text REFERENCES users(id),
        submitted_by text REFERENCES users(id),
        decided_by text REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        locked_at timestamptz,
        exported_at timestamptz,
        submitted_at timestamptz,
        decided_at timestamptz,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        CHECK (net_change = total_additions - total_removals)
      );

      CREATE INDEX cost_amendments_project_status_idx
        ON cost_amendments(project_id, status, updated_at DESC, id);
      CREATE INDEX cost_amendments_report_snapshot_idx
        ON cost_amendments(base_report_snapshot_id);
      CREATE INDEX cost_amendments_created_by_idx ON cost_amendments(created_by);
      CREATE INDEX cost_amendments_updated_by_idx ON cost_amendments(updated_by);
      CREATE INDEX cost_amendments_locked_by_idx ON cost_amendments(locked_by);
      CREATE INDEX cost_amendments_submitted_by_idx ON cost_amendments(submitted_by);
      CREATE INDEX cost_amendments_decided_by_idx ON cost_amendments(decided_by);
      CREATE UNIQUE INDEX cost_amendments_one_active_per_event
        ON cost_amendments(project_id, event_reference)
        WHERE status IN ('locked', 'exported', 'manually-submitted');

      CREATE TABLE cost_amendment_items (
        id text PRIMARY KEY,
        amendment_id text NOT NULL
          REFERENCES cost_amendments(id) ON DELETE CASCADE,
        action text NOT NULL CHECK (action IN ('add', 'remove')),
        node_id text REFERENCES cost_nodes(id) ON DELETE SET NULL,
        description text NOT NULL,
        cost_box text NOT NULL CHECK (
          cost_box IN ('material', 'process', 'fastener', 'tooling')
        ),
        classification text NOT NULL CHECK (
          classification IN (
            'new', 'deleted', 'modified', 'quantity-change', 'unresolved'
          )
        ),
        change_group_id text,
        quantity numeric NOT NULL CHECK (quantity > 0),
        original_quantity numeric NOT NULL CHECK (original_quantity >= 0),
        revised_quantity numeric NOT NULL CHECK (revised_quantity >= 0),
        unit_cost numeric NOT NULL CHECK (unit_cost >= 0),
        subtotal numeric NOT NULL CHECK (subtotal >= 0),
        source_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
      );

      CREATE INDEX cost_amendment_items_amendment_sort_idx
        ON cost_amendment_items(amendment_id, sort_order, id);
      CREATE INDEX cost_amendment_items_node_id_idx
        ON cost_amendment_items(node_id);
      CREATE INDEX cost_amendment_items_change_group_id_idx
        ON cost_amendment_items(change_group_id)
        WHERE change_group_id IS NOT NULL;

      CREATE TABLE artifacts (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN (
          'cost-report', 'supporting-workbook', 'cost-amendment',
          'submission-manifest', 'submission-package', 'other'
        )),
        status text NOT NULL CHECK (status IN ('reserved', 'complete', 'failed')),
        storage_path text,
        content_sha256 char(64)
          CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
        byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
        mime_type text,
        report_snapshot_id text REFERENCES report_snapshots(id),
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by text NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        error_message text,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        CHECK (
          status <> 'complete'
          OR (
            storage_path IS NOT NULL
            AND content_sha256 IS NOT NULL
            AND byte_size IS NOT NULL
            AND mime_type IS NOT NULL
            AND completed_at IS NOT NULL
          )
        )
      );

      CREATE INDEX artifacts_project_kind_created_idx
        ON artifacts(project_id, kind, created_at DESC, id);
      CREATE INDEX artifacts_report_snapshot_id_idx
        ON artifacts(report_snapshot_id);
      CREATE INDEX artifacts_created_by_idx ON artifacts(created_by);

      CREATE TABLE submissions (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status text NOT NULL
          CHECK (status IN ('prepared', 'exported', 'manually-submitted')),
        report_snapshot_id text NOT NULL REFERENCES report_snapshots(id),
        cost_amendment_id text REFERENCES cost_amendments(id),
        supporting_artifact_id text REFERENCES artifacts(id),
        amendment_artifact_id text REFERENCES artifacts(id),
        manifest_artifact_id text REFERENCES artifacts(id),
        package_artifact_id text REFERENCES artifacts(id),
        manifest_json jsonb NOT NULL,
        external_reference text,
        prepared_by text NOT NULL REFERENCES users(id),
        exported_by text REFERENCES users(id),
        submitted_by text REFERENCES users(id),
        prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        exported_at timestamptz,
        submitted_at timestamptz,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
      );

      CREATE INDEX submissions_project_status_idx
        ON submissions(project_id, status, prepared_at DESC, id);
      CREATE INDEX submissions_report_snapshot_id_idx
        ON submissions(report_snapshot_id);
      CREATE INDEX submissions_cost_amendment_id_idx
        ON submissions(cost_amendment_id);
      CREATE INDEX submissions_supporting_artifact_id_idx
        ON submissions(supporting_artifact_id);
      CREATE INDEX submissions_amendment_artifact_id_idx
        ON submissions(amendment_artifact_id);
      CREATE INDEX submissions_manifest_artifact_id_idx
        ON submissions(manifest_artifact_id);
      CREATE INDEX submissions_package_artifact_id_idx
        ON submissions(package_artifact_id);
      CREATE INDEX submissions_prepared_by_idx ON submissions(prepared_by);
      CREATE INDEX submissions_exported_by_idx ON submissions(exported_by);
      CREATE INDEX submissions_submitted_by_idx ON submissions(submitted_by);

      CREATE SEQUENCE audit_ledger_sequence_seq AS bigint START WITH 1;

      CREATE TABLE audit_ledger (
        sequence bigint PRIMARY KEY
          DEFAULT nextval('audit_ledger_sequence_seq'),
        previous_hash text,
        entry_hash text NOT NULL UNIQUE,
        actor_user_id text REFERENCES users(id),
        project_id text REFERENCES projects(id),
        request_id text NOT NULL,
        action text NOT NULL,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        before_json jsonb,
        after_json jsonb,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL
      );

      ALTER SEQUENCE audit_ledger_sequence_seq
        OWNED BY audit_ledger.sequence;
      CREATE INDEX audit_ledger_actor_time_idx
        ON audit_ledger(actor_user_id, occurred_at DESC, sequence DESC);
      CREATE INDEX audit_ledger_project_time_idx
        ON audit_ledger(project_id, occurred_at DESC, sequence DESC);
      CREATE INDEX audit_ledger_request_id_idx ON audit_ledger(request_id);

      CREATE OR REPLACE FUNCTION reject_immutable_row_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END;
      $$;

      CREATE TRIGGER source_documents_immutable
        BEFORE UPDATE OR DELETE ON source_documents
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
      CREATE TRIGGER catalogue_releases_immutable
        BEFORE UPDATE OR DELETE ON catalogue_releases
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
      CREATE TRIGGER catalogue_items_immutable
        BEFORE UPDATE OR DELETE ON catalogue_items
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
      CREATE TRIGGER audit_ledger_append_only
        BEFORE UPDATE OR DELETE ON audit_ledger
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

      CREATE OR REPLACE FUNCTION guard_report_snapshot_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'report snapshots are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.status IN ('complete', 'failed') THEN
          RAISE EXCEPTION 'terminal report snapshots are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.project_id IS DISTINCT FROM NEW.project_id
          OR OLD.mode IS DISTINCT FROM NEW.mode
          OR OLD.snapshot_json IS DISTINCT FROM NEW.snapshot_json
          OR OLD.validation_json IS DISTINCT FROM NEW.validation_json
          OR OLD.source_hashes_json IS DISTINCT FROM NEW.source_hashes_json
          OR OLD.created_by IS DISTINCT FROM NEW.created_by
          OR OLD.created_at IS DISTINCT FROM NEW.created_at
        THEN
          RAISE EXCEPTION 'report snapshot source data is immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER report_snapshots_immutable
        BEFORE UPDATE OR DELETE ON report_snapshots
        FOR EACH ROW EXECUTE FUNCTION guard_report_snapshot_mutation();

      CREATE OR REPLACE FUNCTION guard_artifact_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND OLD.status = 'complete' THEN
          RAISE EXCEPTION 'complete artifacts are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'complete' THEN
          RAISE EXCEPTION 'complete artifacts are immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$;

      CREATE TRIGGER artifacts_terminal_immutable
        BEFORE UPDATE OR DELETE ON artifacts
        FOR EACH ROW EXECUTE FUNCTION guard_artifact_mutation();
    `,
  },
  {
    version: 2,
    name: "freeze CAIR evidence provenance",
    sql: `
      ALTER TABLE evidence
        ADD COLUMN byte_size bigint
          CHECK (byte_size IS NULL OR byte_size >= 0);

      ALTER TABLE cair_evidence
        ADD COLUMN attached_by text REFERENCES users(id),
        ADD COLUMN attached_at timestamptz NOT NULL
          DEFAULT clock_timestamp(),
        ADD COLUMN frozen_content_sha256 char(64)
          CHECK (
            frozen_content_sha256 IS NULL
            OR frozen_content_sha256 ~ '^[0-9a-f]{64}$'
          ),
        ADD COLUMN frozen_byte_size bigint
          CHECK (frozen_byte_size IS NULL OR frozen_byte_size >= 0),
        ADD COLUMN frozen_evidence_version integer
          CHECK (
            frozen_evidence_version IS NULL
            OR frozen_evidence_version >= 0
          ),
        ADD COLUMN frozen_metadata_json jsonb,
        ADD COLUMN frozen_at timestamptz,
        ADD CONSTRAINT cair_evidence_frozen_snapshot_complete CHECK (
          (
            frozen_at IS NULL
            AND frozen_content_sha256 IS NULL
            AND frozen_byte_size IS NULL
            AND frozen_evidence_version IS NULL
            AND frozen_metadata_json IS NULL
          )
          OR (
            frozen_at IS NOT NULL
            AND frozen_content_sha256 IS NOT NULL
            AND frozen_byte_size IS NOT NULL
            AND frozen_evidence_version IS NOT NULL
            AND jsonb_typeof(frozen_metadata_json) = 'object'
          )
        );

      UPDATE cair_evidence ce
      SET attached_by = cr.created_by,
          attached_at = cr.created_at
      FROM cair_requests cr
      WHERE cr.id = ce.cair_id
        AND ce.attached_by IS NULL;

      ALTER TABLE cair_evidence
        ALTER COLUMN attached_by SET NOT NULL;

      CREATE INDEX cair_evidence_attached_by_idx
        ON cair_evidence(attached_by);

      CREATE OR REPLACE FUNCTION guard_cair_evidence_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parent_status text;
        source_sha256 char(64);
        source_byte_size bigint;
        source_version integer;
        source_metadata jsonb;
      BEGIN
        SELECT status INTO parent_status
        FROM cair_requests
        WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.cair_id ELSE OLD.cair_id END;

        IF TG_OP = 'INSERT' THEN
          IF parent_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'CAIR evidence can only be attached in draft'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          IF parent_status IS DISTINCT FROM 'draft'
            OR OLD.frozen_at IS NOT NULL
          THEN
            RAISE EXCEPTION 'frozen CAIR evidence is immutable'
              USING ERRCODE = '55000';
          END IF;
          RETURN OLD;
        END IF;

        IF OLD.cair_id IS DISTINCT FROM NEW.cair_id
          OR OLD.evidence_id IS DISTINCT FROM NEW.evidence_id
          OR OLD.attached_by IS DISTINCT FROM NEW.attached_by
          OR OLD.attached_at IS DISTINCT FROM NEW.attached_at
          OR OLD.frozen_at IS NOT NULL
          OR NEW.frozen_at IS NULL
        THEN
          RAISE EXCEPTION 'CAIR evidence identity is immutable'
            USING ERRCODE = '55000';
        END IF;
        SELECT
          e.content_sha256,
          e.byte_size,
          e.version,
          jsonb_build_object(
            'evidenceId', e.id,
            'displayName', e.display_name,
            'kind', e.kind,
            'mimeType', e.mime_type,
            'visibility', e.visibility,
            'reportCaption', e.report_caption
          )
        INTO
          source_sha256,
          source_byte_size,
          source_version,
          source_metadata
        FROM evidence e
        WHERE e.id = OLD.evidence_id;
        IF source_sha256 IS NULL
          OR source_byte_size IS NULL
          OR NEW.frozen_content_sha256 IS DISTINCT FROM source_sha256
          OR NEW.frozen_byte_size IS DISTINCT FROM source_byte_size
          OR NEW.frozen_evidence_version IS DISTINCT FROM source_version
          OR NEW.frozen_metadata_json IS DISTINCT FROM source_metadata
        THEN
          RAISE EXCEPTION 'CAIR evidence freeze must match source evidence'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER cair_evidence_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cair_evidence
        FOR EACH ROW EXECUTE FUNCTION guard_cair_evidence_mutation();

      CREATE OR REPLACE FUNCTION guard_frozen_cair_evidence_source()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM cair_evidence ce
          WHERE ce.evidence_id = OLD.id
            AND ce.frozen_at IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'evidence frozen by a submitted CAIR is immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$;

      CREATE TRIGGER evidence_frozen_cair_guard
        BEFORE UPDATE OR DELETE ON evidence
        FOR EACH ROW EXECUTE FUNCTION guard_frozen_cair_evidence_source();
    `,
  },
  {
    version: 3,
    name: "durable idempotent submission preparation",
    sql: `
      CREATE TABLE submission_preparations (
        id text PRIMARY KEY,
        project_id text NOT NULL
          REFERENCES projects(id) ON DELETE CASCADE,
        report_snapshot_id text NOT NULL
          REFERENCES report_snapshots(id),
        supporting_artifact_id text NOT NULL
          REFERENCES artifacts(id),
        package_artifact_id text NOT NULL UNIQUE
          REFERENCES artifacts(id),
        manifest_artifact_id text NOT NULL UNIQUE
          REFERENCES artifacts(id),
        status text NOT NULL CHECK (
          status IN ('reserved', 'generating', 'failed', 'complete')
        ),
        prepared_by text NOT NULL REFERENCES users(id),
        prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        attempt_count integer NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0),
        last_attempt_by text REFERENCES users(id),
        last_attempt_at timestamptz,
        last_error text,
        completed_submission_id text UNIQUE
          REFERENCES submissions(id),
        completed_at timestamptz,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        CHECK (
          completed_submission_id IS NULL
          OR completed_submission_id = id
        ),
        UNIQUE (
          project_id,
          report_snapshot_id,
          supporting_artifact_id
        ),
        CHECK (
          (
            status = 'complete'
            AND completed_submission_id IS NOT NULL
            AND completed_at IS NOT NULL
            AND last_error IS NULL
          )
          OR (
            status <> 'complete'
            AND completed_submission_id IS NULL
            AND completed_at IS NULL
          )
        )
      );

      CREATE INDEX submission_preparations_project_status_idx
        ON submission_preparations(
          project_id, status, prepared_at DESC, id
        );
      CREATE INDEX submission_preparations_report_snapshot_id_idx
        ON submission_preparations(report_snapshot_id);
      CREATE INDEX submission_preparations_supporting_artifact_id_idx
        ON submission_preparations(supporting_artifact_id);
      CREATE INDEX submission_preparations_prepared_by_idx
        ON submission_preparations(prepared_by);
      CREATE INDEX submission_preparations_last_attempt_by_idx
        ON submission_preparations(last_attempt_by)
        WHERE last_attempt_by IS NOT NULL;
      CREATE INDEX submission_preparations_recoverable_idx
        ON submission_preparations(project_id, prepared_at, id)
        WHERE status IN ('reserved', 'generating', 'failed');

      CREATE OR REPLACE FUNCTION guard_submission_preparation_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'submission preparations are durable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.id IS DISTINCT FROM NEW.id
          OR OLD.project_id IS DISTINCT FROM NEW.project_id
          OR OLD.report_snapshot_id IS DISTINCT FROM NEW.report_snapshot_id
          OR OLD.supporting_artifact_id IS DISTINCT FROM NEW.supporting_artifact_id
          OR OLD.package_artifact_id IS DISTINCT FROM NEW.package_artifact_id
          OR OLD.manifest_artifact_id IS DISTINCT FROM NEW.manifest_artifact_id
          OR OLD.prepared_by IS DISTINCT FROM NEW.prepared_by
          OR OLD.prepared_at IS DISTINCT FROM NEW.prepared_at
        THEN
          RAISE EXCEPTION 'submission preparation identity is immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.status = 'complete' THEN
          RAISE EXCEPTION 'complete submission preparations are immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER submission_preparations_guard
        BEFORE UPDATE OR DELETE ON submission_preparations
        FOR EACH ROW
        EXECUTE FUNCTION guard_submission_preparation_mutation();
    `,
  },
  {
    version: 4,
    name: "freeze submitted project state",
    sql: `
      CREATE OR REPLACE FUNCTION assert_project_accepts_mutation(
        target_project_id text
      )
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      DECLARE
        project_status text;
      BEGIN
        SELECT status
        INTO project_status
        FROM projects
        WHERE id = target_project_id
        FOR SHARE;

        IF project_status = 'submitted' THEN
          RAISE EXCEPTION 'project-submitted-read-only'
            USING ERRCODE = '55000';
        END IF;
      END;
      $$;

      CREATE OR REPLACE FUNCTION guard_direct_project_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        old_project_id text;
        new_project_id text;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          old_project_id := to_jsonb(OLD) ->> 'project_id';
          PERFORM assert_project_accepts_mutation(old_project_id);
        END IF;
        IF TG_OP <> 'DELETE' THEN
          new_project_id := to_jsonb(NEW) ->> 'project_id';
          IF new_project_id IS DISTINCT FROM old_project_id THEN
            PERFORM assert_project_accepts_mutation(new_project_id);
          END IF;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$;

      CREATE OR REPLACE FUNCTION guard_indirect_project_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        old_parent_id text;
        new_parent_id text;
        old_project_id text;
        new_project_id text;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          old_parent_id := to_jsonb(OLD) ->> TG_ARGV[1];
        END IF;
        IF TG_OP <> 'DELETE' THEN
          new_parent_id := to_jsonb(NEW) ->> TG_ARGV[1];
        END IF;

        IF TG_ARGV[0] = 'cost-node' THEN
          SELECT project_id INTO old_project_id
          FROM cost_nodes WHERE id = old_parent_id;
          SELECT project_id INTO new_project_id
          FROM cost_nodes WHERE id = new_parent_id;
        ELSIF TG_ARGV[0] = 'import-batch' THEN
          SELECT project_id INTO old_project_id
          FROM import_batches WHERE id = old_parent_id;
          SELECT project_id INTO new_project_id
          FROM import_batches WHERE id = new_parent_id;
        ELSIF TG_ARGV[0] = 'cair' THEN
          SELECT project_id INTO old_project_id
          FROM cair_requests WHERE id = old_parent_id;
          SELECT project_id INTO new_project_id
          FROM cair_requests WHERE id = new_parent_id;
        ELSIF TG_ARGV[0] = 'cost-amendment' THEN
          SELECT project_id INTO old_project_id
          FROM cost_amendments WHERE id = old_parent_id;
          SELECT project_id INTO new_project_id
          FROM cost_amendments WHERE id = new_parent_id;
        ELSE
          RAISE EXCEPTION 'unknown submitted-project guard relation'
            USING ERRCODE = '55000';
        END IF;

        IF old_project_id IS NOT NULL THEN
          PERFORM assert_project_accepts_mutation(old_project_id);
        END IF;
        IF new_project_id IS NOT NULL
          AND new_project_id IS DISTINCT FROM old_project_id
        THEN
          PERFORM assert_project_accepts_mutation(new_project_id);
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$;

      CREATE OR REPLACE FUNCTION guard_submitted_project_row()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.status <> 'submitted' THEN
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'project-submitted-read-only'
            USING ERRCODE = '55000';
        END IF;
        IF NEW.status NOT IN ('draft', 'review')
          OR (
            to_jsonb(OLD) - ARRAY[
              'status', 'updated_by', 'updated_at', 'version'
            ]::text[]
          ) IS DISTINCT FROM (
            to_jsonb(NEW) - ARRAY[
              'status', 'updated_by', 'updated_at', 'version'
            ]::text[]
          )
        THEN
          RAISE EXCEPTION 'submitted-project-reopen-only'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER projects_submitted_guard
        BEFORE UPDATE OR DELETE ON projects
        FOR EACH ROW EXECUTE FUNCTION guard_submitted_project_row();

      CREATE TRIGGER project_memberships_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON project_memberships
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER import_batches_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON import_batches
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER cost_nodes_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cost_nodes
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER evidence_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON evidence
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER report_snapshots_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON report_snapshots
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER project_setup_confirmations_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON project_setup_confirmations
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER cair_requests_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cair_requests
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER cost_amendments_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cost_amendments
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER artifacts_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON artifacts
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER submissions_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON submissions
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();
      CREATE TRIGGER submission_preparations_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON submission_preparations
        FOR EACH ROW EXECUTE FUNCTION guard_direct_project_mutation();

      CREATE TRIGGER cost_lines_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cost_lines
        FOR EACH ROW
        EXECUTE FUNCTION guard_indirect_project_mutation(
          'cost-node', 'node_id'
        );
      CREATE TRIGGER import_rows_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON import_rows
        FOR EACH ROW
        EXECUTE FUNCTION guard_indirect_project_mutation(
          'import-batch', 'batch_id'
        );
      CREATE TRIGGER import_issues_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON import_issues
        FOR EACH ROW
        EXECUTE FUNCTION guard_indirect_project_mutation(
          'import-batch', 'batch_id'
        );
      CREATE TRIGGER cair_evidence_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cair_evidence
        FOR EACH ROW
        EXECUTE FUNCTION guard_indirect_project_mutation(
          'cair', 'cair_id'
        );
      CREATE TRIGGER cost_amendment_items_submitted_guard
        BEFORE INSERT OR UPDATE OR DELETE ON cost_amendment_items
        FOR EACH ROW
        EXECUTE FUNCTION guard_indirect_project_mutation(
          'cost-amendment', 'amendment_id'
        );
    `,
  },
  {
    version: 5,
    name: "enforce project ownership across references",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM cost_nodes child
          JOIN cost_nodes parent ON parent.id = child.parent_id
          WHERE child.project_id <> parent.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: cost node parent belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM cost_nodes node
          JOIN import_batches batch
            ON batch.id = node.source_import_batch_id
          WHERE node.project_id <> batch.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: cost node import batch belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM evidence item
          JOIN cost_nodes node ON node.id = item.node_id
          WHERE item.project_id <> node.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: evidence node belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM import_rows row
          JOIN import_batches batch ON batch.id = row.batch_id
          JOIN cost_nodes node ON node.id = row.node_id
          WHERE batch.project_id <> node.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: import row node belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM cair_requests request
          JOIN cost_lines line ON line.id = request.cost_line_id
          JOIN cost_nodes node ON node.id = line.node_id
          WHERE request.project_id <> node.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: CAIR cost line belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM cair_evidence attachment
          JOIN cair_requests request ON request.id = attachment.cair_id
          JOIN evidence item ON item.id = attachment.evidence_id
          WHERE request.project_id <> item.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: CAIR evidence belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM cost_amendments amendment
          JOIN report_snapshots report
            ON report.id = amendment.base_report_snapshot_id
          WHERE amendment.project_id <> report.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: cost amendment report belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM cost_amendment_items item
          JOIN cost_amendments amendment ON amendment.id = item.amendment_id
          JOIN cost_nodes node ON node.id = item.node_id
          WHERE amendment.project_id <> node.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: cost amendment node belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM artifacts artifact
          JOIN report_snapshots report
            ON report.id = artifact.report_snapshot_id
          WHERE artifact.project_id <> report.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: artifact report belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM submissions submission
          JOIN report_snapshots report
            ON report.id = submission.report_snapshot_id
          WHERE submission.project_id <> report.project_id
        ) OR EXISTS (
          SELECT 1
          FROM submissions submission
          JOIN cost_amendments amendment
            ON amendment.id = submission.cost_amendment_id
          WHERE submission.project_id <> amendment.project_id
        ) OR EXISTS (
          SELECT 1
          FROM submissions submission
          CROSS JOIN LATERAL (
            VALUES
              (submission.supporting_artifact_id),
              (submission.amendment_artifact_id),
              (submission.manifest_artifact_id),
              (submission.package_artifact_id)
          ) AS reference(artifact_id)
          JOIN artifacts artifact ON artifact.id = reference.artifact_id
          WHERE submission.project_id <> artifact.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: submission reference belongs to another project'
            USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM submission_preparations preparation
          JOIN report_snapshots report
            ON report.id = preparation.report_snapshot_id
          WHERE preparation.project_id <> report.project_id
        ) OR EXISTS (
          SELECT 1
          FROM submission_preparations preparation
          CROSS JOIN LATERAL (
            VALUES
              (preparation.supporting_artifact_id),
              (preparation.package_artifact_id),
              (preparation.manifest_artifact_id)
          ) AS reference(artifact_id)
          JOIN artifacts artifact ON artifact.id = reference.artifact_id
          WHERE preparation.project_id <> artifact.project_id
        ) OR EXISTS (
          SELECT 1
          FROM submission_preparations preparation
          JOIN submissions submission
            ON submission.id = preparation.completed_submission_id
          WHERE preparation.project_id <> submission.project_id
        ) THEN
          RAISE EXCEPTION
            'migration blocked: submission preparation reference belongs to another project'
            USING ERRCODE = '23503';
        END IF;
      END;
      $$;

      ALTER TABLE import_batches
        ADD CONSTRAINT import_batches_id_project_unique
          UNIQUE (id, project_id);
      ALTER TABLE cost_nodes
        ADD CONSTRAINT cost_nodes_id_project_unique
          UNIQUE (id, project_id);
      ALTER TABLE report_snapshots
        ADD CONSTRAINT report_snapshots_id_project_unique
          UNIQUE (id, project_id);
      ALTER TABLE cost_amendments
        ADD CONSTRAINT cost_amendments_id_project_unique
          UNIQUE (id, project_id);
      ALTER TABLE artifacts
        ADD CONSTRAINT artifacts_id_project_unique
          UNIQUE (id, project_id);
      ALTER TABLE submissions
        ADD CONSTRAINT submissions_id_project_unique
          UNIQUE (id, project_id);

      ALTER TABLE cost_nodes
        DROP CONSTRAINT cost_nodes_parent_id_fkey,
        DROP CONSTRAINT cost_nodes_source_import_batch_id_fkey,
        ADD CONSTRAINT cost_nodes_parent_project_fkey
          FOREIGN KEY (parent_id, project_id)
          REFERENCES cost_nodes(id, project_id)
          ON DELETE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT cost_nodes_import_batch_project_fkey
          FOREIGN KEY (source_import_batch_id, project_id)
          REFERENCES import_batches(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;

      ALTER TABLE evidence
        DROP CONSTRAINT evidence_node_id_fkey,
        ADD CONSTRAINT evidence_node_project_fkey
          FOREIGN KEY (node_id, project_id)
          REFERENCES cost_nodes(id, project_id)
          ON DELETE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;

      ALTER TABLE cost_amendments
        DROP CONSTRAINT cost_amendments_base_report_snapshot_id_fkey,
        ADD CONSTRAINT cost_amendments_report_project_fkey
          FOREIGN KEY (base_report_snapshot_id, project_id)
          REFERENCES report_snapshots(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;

      ALTER TABLE artifacts
        DROP CONSTRAINT artifacts_report_snapshot_id_fkey,
        ADD CONSTRAINT artifacts_report_project_fkey
          FOREIGN KEY (report_snapshot_id, project_id)
          REFERENCES report_snapshots(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;

      ALTER TABLE submissions
        DROP CONSTRAINT submissions_report_snapshot_id_fkey,
        DROP CONSTRAINT submissions_cost_amendment_id_fkey,
        DROP CONSTRAINT submissions_supporting_artifact_id_fkey,
        DROP CONSTRAINT submissions_amendment_artifact_id_fkey,
        DROP CONSTRAINT submissions_manifest_artifact_id_fkey,
        DROP CONSTRAINT submissions_package_artifact_id_fkey,
        ADD CONSTRAINT submissions_report_project_fkey
          FOREIGN KEY (report_snapshot_id, project_id)
          REFERENCES report_snapshots(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submissions_amendment_project_fkey
          FOREIGN KEY (cost_amendment_id, project_id)
          REFERENCES cost_amendments(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submissions_supporting_artifact_project_fkey
          FOREIGN KEY (supporting_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submissions_amendment_artifact_project_fkey
          FOREIGN KEY (amendment_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submissions_manifest_artifact_project_fkey
          FOREIGN KEY (manifest_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submissions_package_artifact_project_fkey
          FOREIGN KEY (package_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;

      ALTER TABLE submission_preparations
        DROP CONSTRAINT submission_preparations_report_snapshot_id_fkey,
        DROP CONSTRAINT submission_preparations_supporting_artifact_id_fkey,
        DROP CONSTRAINT submission_preparations_package_artifact_id_fkey,
        DROP CONSTRAINT submission_preparations_manifest_artifact_id_fkey,
        DROP CONSTRAINT submission_preparations_completed_submission_id_fkey,
        ADD CONSTRAINT submission_preparations_report_project_fkey
          FOREIGN KEY (report_snapshot_id, project_id)
          REFERENCES report_snapshots(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submission_preparations_supporting_artifact_project_fkey
          FOREIGN KEY (supporting_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submission_preparations_package_artifact_project_fkey
          FOREIGN KEY (package_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submission_preparations_manifest_artifact_project_fkey
          FOREIGN KEY (manifest_artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID,
        ADD CONSTRAINT submission_preparations_completed_submission_project_fkey
          FOREIGN KEY (completed_submission_id, project_id)
          REFERENCES submissions(id, project_id)
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;

      ALTER TABLE cost_nodes
        VALIDATE CONSTRAINT cost_nodes_parent_project_fkey,
        VALIDATE CONSTRAINT cost_nodes_import_batch_project_fkey;
      ALTER TABLE evidence
        VALIDATE CONSTRAINT evidence_node_project_fkey;
      ALTER TABLE cost_amendments
        VALIDATE CONSTRAINT cost_amendments_report_project_fkey;
      ALTER TABLE artifacts
        VALIDATE CONSTRAINT artifacts_report_project_fkey;
      ALTER TABLE submissions
        VALIDATE CONSTRAINT submissions_report_project_fkey,
        VALIDATE CONSTRAINT submissions_amendment_project_fkey,
        VALIDATE CONSTRAINT submissions_supporting_artifact_project_fkey,
        VALIDATE CONSTRAINT submissions_amendment_artifact_project_fkey,
        VALIDATE CONSTRAINT submissions_manifest_artifact_project_fkey,
        VALIDATE CONSTRAINT submissions_package_artifact_project_fkey;
      ALTER TABLE submission_preparations
        VALIDATE CONSTRAINT submission_preparations_report_project_fkey,
        VALIDATE CONSTRAINT submission_preparations_supporting_artifact_project_fkey,
        VALIDATE CONSTRAINT submission_preparations_package_artifact_project_fkey,
        VALIDATE CONSTRAINT submission_preparations_manifest_artifact_project_fkey,
        VALIDATE CONSTRAINT submission_preparations_completed_submission_project_fkey;

      CREATE OR REPLACE FUNCTION assert_child_project_ownership()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        owner_project_id text;
        referenced_project_id text;
      BEGIN
        IF TG_TABLE_NAME = 'import_rows' THEN
          IF NEW.node_id IS NULL THEN
            RETURN NULL;
          END IF;
          SELECT batch.project_id, node.project_id
          INTO owner_project_id, referenced_project_id
          FROM import_batches batch
          JOIN cost_nodes node ON node.id = NEW.node_id
          WHERE batch.id = NEW.batch_id;
        ELSIF TG_TABLE_NAME = 'cair_requests' THEN
          IF NEW.cost_line_id IS NULL THEN
            RETURN NULL;
          END IF;
          owner_project_id := NEW.project_id;
          SELECT node.project_id
          INTO referenced_project_id
          FROM cost_lines line
          JOIN cost_nodes node ON node.id = line.node_id
          WHERE line.id = NEW.cost_line_id;
        ELSIF TG_TABLE_NAME = 'cair_evidence' THEN
          SELECT request.project_id, item.project_id
          INTO owner_project_id, referenced_project_id
          FROM cair_requests request
          JOIN evidence item ON item.id = NEW.evidence_id
          WHERE request.id = NEW.cair_id;
        ELSIF TG_TABLE_NAME = 'cost_amendment_items' THEN
          IF NEW.node_id IS NULL THEN
            RETURN NULL;
          END IF;
          SELECT amendment.project_id, node.project_id
          INTO owner_project_id, referenced_project_id
          FROM cost_amendments amendment
          JOIN cost_nodes node ON node.id = NEW.node_id
          WHERE amendment.id = NEW.amendment_id;
        ELSE
          RAISE EXCEPTION 'unknown project ownership child relation'
            USING ERRCODE = '55000';
        END IF;

        IF owner_project_id IS NOT NULL
          AND referenced_project_id IS NOT NULL
          AND owner_project_id <> referenced_project_id
        THEN
          RAISE EXCEPTION '% reference belongs to another project',
            TG_TABLE_NAME
            USING ERRCODE = '23503';
        END IF;
        RETURN NULL;
      END;
      $$;

      CREATE OR REPLACE FUNCTION assert_parent_project_ownership()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        referenced_project_id text;
      BEGIN
        IF TG_TABLE_NAME = 'import_batches' THEN
          IF EXISTS (
            SELECT 1
            FROM import_rows row
            JOIN cost_nodes node ON node.id = row.node_id
            WHERE row.batch_id = NEW.id
              AND node.project_id <> NEW.project_id
          ) THEN
            RAISE EXCEPTION
              'import batch project conflicts with an imported node'
              USING ERRCODE = '23503';
          END IF;
        ELSIF TG_TABLE_NAME = 'cost_nodes' THEN
          IF EXISTS (
            SELECT 1
            FROM import_rows row
            JOIN import_batches batch ON batch.id = row.batch_id
            WHERE row.node_id = NEW.id
              AND batch.project_id <> NEW.project_id
          ) OR EXISTS (
            SELECT 1
            FROM cost_lines line
            JOIN cair_requests request
              ON request.cost_line_id = line.id
            WHERE line.node_id = NEW.id
              AND request.project_id <> NEW.project_id
          ) OR EXISTS (
            SELECT 1
            FROM cost_amendment_items item
            JOIN cost_amendments amendment
              ON amendment.id = item.amendment_id
            WHERE item.node_id = NEW.id
              AND amendment.project_id <> NEW.project_id
          ) THEN
            RAISE EXCEPTION
              'cost node project conflicts with an indirect reference'
              USING ERRCODE = '23503';
          END IF;
        ELSIF TG_TABLE_NAME = 'cost_lines' THEN
          SELECT project_id
          INTO referenced_project_id
          FROM cost_nodes
          WHERE id = NEW.node_id;
          IF EXISTS (
            SELECT 1
            FROM cair_requests request
            WHERE request.cost_line_id = NEW.id
              AND request.project_id <> referenced_project_id
          ) THEN
            RAISE EXCEPTION
              'cost line node conflicts with a CAIR project'
              USING ERRCODE = '23503';
          END IF;
        ELSIF TG_TABLE_NAME = 'evidence' THEN
          IF EXISTS (
            SELECT 1
            FROM cair_evidence attachment
            JOIN cair_requests request
              ON request.id = attachment.cair_id
            WHERE attachment.evidence_id = NEW.id
              AND request.project_id <> NEW.project_id
          ) THEN
            RAISE EXCEPTION
              'evidence project conflicts with a CAIR project'
              USING ERRCODE = '23503';
          END IF;
        ELSIF TG_TABLE_NAME = 'cair_requests' THEN
          IF EXISTS (
            SELECT 1
            FROM cair_evidence attachment
            JOIN evidence item ON item.id = attachment.evidence_id
            WHERE attachment.cair_id = NEW.id
              AND item.project_id <> NEW.project_id
          ) THEN
            RAISE EXCEPTION
              'CAIR project conflicts with attached evidence'
              USING ERRCODE = '23503';
          END IF;
        ELSIF TG_TABLE_NAME = 'cost_amendments' THEN
          IF EXISTS (
            SELECT 1
            FROM cost_amendment_items item
            JOIN cost_nodes node ON node.id = item.node_id
            WHERE item.amendment_id = NEW.id
              AND node.project_id <> NEW.project_id
          ) THEN
            RAISE EXCEPTION
              'cost amendment project conflicts with an item node'
              USING ERRCODE = '23503';
          END IF;
        ELSE
          RAISE EXCEPTION 'unknown project ownership parent relation'
            USING ERRCODE = '55000';
        END IF;
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER import_rows_project_ownership
        AFTER INSERT OR UPDATE OF batch_id, node_id ON import_rows
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_child_project_ownership();
      CREATE CONSTRAINT TRIGGER cair_requests_project_ownership
        AFTER INSERT OR UPDATE OF project_id, cost_line_id ON cair_requests
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_child_project_ownership();
      CREATE CONSTRAINT TRIGGER cair_evidence_project_ownership
        AFTER INSERT OR UPDATE OF cair_id, evidence_id ON cair_evidence
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_child_project_ownership();
      CREATE CONSTRAINT TRIGGER cost_amendment_items_project_ownership
        AFTER INSERT OR UPDATE OF amendment_id, node_id
        ON cost_amendment_items
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_child_project_ownership();
      CREATE CONSTRAINT TRIGGER import_batches_project_ownership
        AFTER UPDATE OF project_id ON import_batches
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_parent_project_ownership();
      CREATE CONSTRAINT TRIGGER cost_nodes_project_ownership
        AFTER UPDATE OF project_id ON cost_nodes
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_parent_project_ownership();
      CREATE CONSTRAINT TRIGGER cost_lines_project_ownership
        AFTER UPDATE OF node_id ON cost_lines
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_parent_project_ownership();
      CREATE CONSTRAINT TRIGGER evidence_project_ownership
        AFTER UPDATE OF project_id ON evidence
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_parent_project_ownership();
      CREATE CONSTRAINT TRIGGER cair_requests_parent_project_ownership
        AFTER UPDATE OF project_id ON cair_requests
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_parent_project_ownership();
      CREATE CONSTRAINT TRIGGER cost_amendments_project_ownership
        AFTER UPDATE OF project_id ON cost_amendments
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW EXECUTE FUNCTION assert_parent_project_ownership();
    `,
  },
  {
    version: 6,
    name: "email and shared access key authentication",
    sql: `
      ALTER TABLE users
        DROP COLUMN password_hash;

      UPDATE users
      SET status = 'active',
          updated_at = clock_timestamp(),
          version = version + 1
      WHERE status = 'invited';

      UPDATE user_invites
      SET revoked_at = COALESCE(revoked_at, clock_timestamp())
      WHERE accepted_at IS NULL
        AND revoked_at IS NULL;

      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, clock_timestamp())
      WHERE revoked_at IS NULL;

      ALTER TABLE sessions
        ADD COLUMN shared_key_fingerprint char(64)
          CHECK (
            shared_key_fingerprint IS NULL
            OR shared_key_fingerprint ~ '^[0-9a-f]{64}$'
          );
    `,
  },
  {
    version: 7,
    name: "role-specific access keys",
    sql: `
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, clock_timestamp())
      WHERE revoked_at IS NULL;

      ALTER TABLE sessions
        RENAME COLUMN shared_key_fingerprint TO access_key_fingerprint;

      ALTER TABLE sessions
        RENAME CONSTRAINT sessions_shared_key_fingerprint_check
        TO sessions_access_key_fingerprint_check;
    `,
  },
  {
    version: 8,
    name: "deadline fallback reports",
    sql: `
      ALTER TABLE report_snapshots
        DROP CONSTRAINT report_snapshots_mode_check;

      ALTER TABLE report_snapshots
        ADD CONSTRAINT report_snapshots_mode_check
        CHECK (mode IN ('draft', 'deadline', 'competition-ready'));
    `,
  },
  {
    version: 9,
    name: "neutral full report exports",
    sql: `
      ALTER TABLE report_snapshots
        DROP CONSTRAINT report_snapshots_mode_check;

      ALTER TABLE report_snapshots
        ADD CONSTRAINT report_snapshots_mode_check
        CHECK (mode IN (
          'draft', 'deadline', 'competition-ready', 'export'
        ));
    `,
  },
  {
    version: 10,
    name: "multi-season workspaces and portable lineage",
    sql: `
      ALTER TABLE projects
        ADD COLUMN is_historical boolean NOT NULL DEFAULT false;

      CREATE UNIQUE INDEX projects_active_season_unique
        ON projects(season)
        WHERE archived_at IS NULL;

      CREATE TABLE cost_node_lineage (
        id text PRIMARY KEY,
        source_project_id text NOT NULL,
        source_node_id text NOT NULL,
        target_project_id text NOT NULL,
        target_node_id text NOT NULL,
        copied_by text NOT NULL REFERENCES users(id),
        copied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        options_json jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(options_json) = 'object'),
        FOREIGN KEY (source_node_id, source_project_id)
          REFERENCES cost_nodes(id, project_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (target_node_id, target_project_id)
          REFERENCES cost_nodes(id, project_id)
          ON DELETE CASCADE,
        UNIQUE (target_node_id, target_project_id)
      );

      CREATE INDEX cost_node_lineage_source_idx
        ON cost_node_lineage(source_project_id, source_node_id);
      CREATE INDEX cost_node_lineage_target_idx
        ON cost_node_lineage(target_project_id, target_node_id);

      CREATE TABLE project_copy_operations (
        id text PRIMARY KEY,
        source_project_id text NOT NULL REFERENCES projects(id),
        target_project_id text NOT NULL REFERENCES projects(id),
        idempotency_key text NOT NULL,
        request_json jsonb NOT NULL
          CHECK (jsonb_typeof(request_json) = 'object'),
        result_json jsonb NOT NULL
          CHECK (jsonb_typeof(result_json) = 'object'),
        created_by text NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (target_project_id, idempotency_key)
      );

      CREATE INDEX project_copy_operations_source_idx
        ON project_copy_operations(source_project_id, created_at DESC);

      CREATE TABLE project_archive_imports (
        id text PRIMARY KEY,
        target_project_id text NOT NULL REFERENCES projects(id),
        source_sha256 char(64) NOT NULL
          CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key text NOT NULL,
        result_json jsonb NOT NULL
          CHECK (jsonb_typeof(result_json) = 'object'),
        created_by text NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (idempotency_key),
        UNIQUE (source_sha256, target_project_id)
      );

      UPDATE sessions AS session
      SET revoked_at = COALESCE(session.revoked_at, clock_timestamp())
      FROM users AS account
      WHERE session.user_id = account.id
        AND account.role = 'viewer'
        AND session.revoked_at IS NULL;
    `,
  },
  {
    version: 11,
    name: "shared catalogue rows and revisions",
    sql: `
      ALTER TABLE catalogue_items
        ADD COLUMN origin text NOT NULL DEFAULT 'official'
          CHECK (origin IN ('official', 'team')),
        ADD COLUMN created_by text REFERENCES users(id),
        ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();

      CREATE INDEX catalogue_items_release_origin_idx
        ON catalogue_items(release_id, origin, kind, name);

      CREATE TABLE catalogue_item_revisions (
        id text PRIMARY KEY,
        catalogue_item_id text NOT NULL REFERENCES catalogue_items(id),
        revision integer NOT NULL CHECK (revision > 0),
        name text NOT NULL CHECK (btrim(name) <> ''),
        category text,
        supplier text,
        unit text,
        unit_2 text,
        raw_formula text,
        fixed_cost numeric CHECK (fixed_cost IS NULL OR fixed_cost >= 0),
        coefficients_json jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(coefficients_json) = 'object'),
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(metadata_json) = 'object'),
        reason text NOT NULL CHECK (btrim(reason) <> ''),
        evidence text,
        created_by text NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (catalogue_item_id, revision),
        CHECK (raw_formula IS NULL OR fixed_cost IS NULL)
      );

      CREATE INDEX catalogue_item_revisions_latest_idx
        ON catalogue_item_revisions(catalogue_item_id, revision DESC);
      CREATE INDEX catalogue_item_revisions_created_by_idx
        ON catalogue_item_revisions(created_by, created_at DESC);

      CREATE TRIGGER catalogue_item_revisions_immutable
        BEFORE UPDATE OR DELETE ON catalogue_item_revisions
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

      CREATE VIEW effective_catalogue_items AS
      SELECT
        item.id,
        item.release_id,
        item.kind,
        item.catalogue_id,
        CASE
          WHEN latest.id IS NULL THEN item.name
          ELSE latest.name
        END AS name,
        CASE
          WHEN latest.id IS NULL THEN item.category
          ELSE latest.category
        END AS category,
        CASE
          WHEN latest.id IS NULL THEN item.supplier
          ELSE latest.supplier
        END AS supplier,
        CASE
          WHEN latest.id IS NULL THEN item.unit
          ELSE latest.unit
        END AS unit,
        CASE
          WHEN latest.id IS NULL THEN item.unit_2
          ELSE latest.unit_2
        END AS unit_2,
        CASE
          WHEN latest.id IS NULL THEN item.raw_formula
          ELSE latest.raw_formula
        END AS raw_formula,
        CASE
          WHEN latest.id IS NULL THEN item.fixed_cost
          ELSE latest.fixed_cost
        END AS fixed_cost,
        CASE
          WHEN latest.id IS NULL THEN item.coefficients_json
          ELSE latest.coefficients_json
        END AS coefficients_json,
        CASE
          WHEN latest.id IS NULL THEN item.metadata_json
          ELSE latest.metadata_json
        END AS metadata_json,
        item.name AS source_name,
        item.category AS source_category,
        item.supplier AS source_supplier,
        item.unit AS source_unit,
        item.unit_2 AS source_unit_2,
        item.raw_formula AS source_raw_formula,
        item.fixed_cost AS source_fixed_cost,
        item.coefficients_json AS source_coefficients_json,
        item.metadata_json AS source_metadata_json,
        item.source_sheet,
        item.source_row,
        item.raw_json,
        item.origin,
        item.created_by AS item_created_by,
        item.created_at AS item_created_at,
        latest.id AS revision_id,
        COALESCE(latest.revision, 0) AS effective_revision,
        latest.reason AS change_reason,
        latest.evidence AS change_evidence,
        latest.created_by AS change_created_by,
        latest.created_at AS change_created_at
      FROM catalogue_items item
      LEFT JOIN LATERAL (
        SELECT revision.*
        FROM catalogue_item_revisions revision
        WHERE revision.catalogue_item_id = item.id
        ORDER BY revision.revision DESC
        LIMIT 1
      ) latest ON true;
    `,
  },
  {
    version: 12,
    name: "recover official catalogue size units",
    sql: `
      ALTER TABLE catalogue_items
        DISABLE TRIGGER catalogue_items_immutable;

      UPDATE catalogue_items
      SET unit = NULLIF(btrim(metadata_json ->> 'size1unit'), '')
      WHERE origin = 'official'
        AND (unit IS NULL OR btrim(unit) = '')
        AND NULLIF(btrim(metadata_json ->> 'size1unit'), '') IS NOT NULL;

      UPDATE catalogue_items
      SET unit_2 = NULLIF(btrim(metadata_json ->> 'size2unit'), '')
      WHERE origin = 'official'
        AND (unit_2 IS NULL OR btrim(unit_2) = '')
        AND NULLIF(btrim(metadata_json ->> 'size2unit'), '') IS NOT NULL;

      ALTER TABLE catalogue_items
        ENABLE TRIGGER catalogue_items_immutable;
    `,
  },
  {
    version: 13,
    name: "explicit drawing requirements",
    sql: `ALTER TABLE cost_nodes ADD COLUMN drawing_required boolean NOT NULL DEFAULT true;`,
  },
  {
    version: 14,
    name: "explicit isometric image requirements",
    sql: `ALTER TABLE cost_nodes
      ADD COLUMN image_required boolean NOT NULL DEFAULT true,
      ADD COLUMN image_requirement_reason text NOT NULL DEFAULT '';`,
  },
  {
    version: 15,
    name: "shared part flags and comments",
    sql: `
      ALTER TABLE cost_nodes
        ADD COLUMN work_status text NOT NULL DEFAULT 'none'
          CHECK (work_status IN ('none', 'needs-attention', 'done')),
        ADD COLUMN flag_comment text NOT NULL DEFAULT ''
          CHECK (char_length(flag_comment) <= 2000);
    `,
  },
];
