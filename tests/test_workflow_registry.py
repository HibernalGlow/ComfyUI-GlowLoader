"""Tests for WorkflowRegistry."""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from workflow_registry import WorkflowRegistry


class TestRegister:
    def test_first_workflow_becomes_active(self):
        r = WorkflowRegistry()
        wf = r.register("wf-a", total=5, tab_id="t1")
        assert wf["status"] == "active"
        assert wf["total"] == 5
        assert wf["enqueued"] == 0
        assert wf["executed"] == 0
        assert wf["id"]

    def test_second_workflow_waits(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 5, "t1")
        b = r.register("wf-b", 3, "t2")
        assert a["status"] == "active"
        assert b["status"] == "waiting"
        st = r.get_status()
        assert st["active_id"] == a["id"]


class TestDone:
    def test_done_activates_next(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        b = r.register("wf-b", 2, "t2")
        assert r.mark_done(a["id"]) is True
        st = r.get_status()
        assert st["active_id"] == b["id"]
        assert st["workflows"][0]["status"] == "done"
        assert st["workflows"][1]["status"] == "active"

    def test_done_unknown_returns_false(self):
        r = WorkflowRegistry()
        assert r.mark_done("nope") is False


class TestPromptTracking:
    def test_record_prompt_increments_enqueued(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        assert r.record_prompt(a["id"], "pid-1") is True
        assert r.record_prompt(a["id"], "pid-2") is True
        st = r.get_status()
        assert st["workflows"][0]["enqueued"] == 2

    def test_record_executed_increments_executed(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        r.record_prompt(a["id"], "pid-1")
        r.record_prompt(a["id"], "pid-2")
        r.record_executed(a["id"], "pid-1")
        r.record_executed(a["id"], "pid-1")  # idempotent
        assert r.get_status()["workflows"][0]["executed"] == 1
        r.record_executed(a["id"], "pid-2")
        assert r.get_status()["workflows"][0]["executed"] == 2


class TestAbort:
    def test_abort_returns_prompt_ids_and_activates_next(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        b = r.register("wf-b", 2, "t2")
        r.record_prompt(a["id"], "pid-1")
        r.record_prompt(a["id"], "pid-2")
        ids = r.abort(a["id"])
        assert ids == ["pid-1", "pid-2"]
        st = r.get_status()
        assert st["active_id"] == b["id"]
        assert st["workflows"][0]["status"] == "aborted"

    def test_abort_batch(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 1, "t1")
        b = r.register("wf-b", 1, "t2")
        c = r.register("wf-c", 1, "t3")
        r.record_prompt(a["id"], "pa")
        r.record_prompt(b["id"], "pb")
        result = r.abort_batch([a["id"], c["id"]])
        assert result[a["id"]] == ["pa"]
        assert result[c["id"]] == []
        st = r.get_status()
        by_id = {w["id"]: w for w in st["workflows"]}
        assert by_id[a["id"]]["status"] == "aborted"
        assert by_id[c["id"]]["status"] == "aborted"
        # b was waiting; after a aborted, b should become active
        assert st["active_id"] == b["id"]


class TestHeartbeat:
    def test_heartbeat_resets_lease(self):
        r = WorkflowRegistry(lease_timeout=0.5)
        a = r.register("wf-a", 1, "t1")
        time.sleep(0.3)
        assert r.heartbeat(a["id"]) is True
        time.sleep(0.3)
        # would have expired without heartbeat, but heartbeat extended it
        st = r.get_status()
        assert st["active_id"] == a["id"]

    def test_stale_active_released_and_next_promoted(self):
        r = WorkflowRegistry(lease_timeout=0.3)
        a = r.register("wf-a", 1, "t1")
        b = r.register("wf-b", 1, "t2")
        time.sleep(0.4)
        st = r.get_status()  # triggers expiry check
        assert st["active_id"] == b["id"]
        by_id = {w["id"]: w for w in st["workflows"]}
        assert by_id[a["id"]]["status"] == "stale"

    def test_heartbeat_non_active_returns_false(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 1, "t1")
        b = r.register("wf-b", 1, "t2")
        assert r.heartbeat(b["id"]) is False


class TestStatusOrder:
    def test_status_preserves_registration_order(self):
        r = WorkflowRegistry()
        r.register("wf-a", 1, "t1")
        r.register("wf-b", 1, "t2")
        r.register("wf-c", 1, "t3")
        st = r.get_status()
        assert [w["name"] for w in st["workflows"]] == ["wf-a", "wf-b", "wf-c"]
