"""Stand-in for Muse's dynamic_credentials module, for tests only.

Returns the placeholder named by FAKE_SURROGATE, the way Muse returns an hsurr: surrogate.
Something between the helper and the relay (the test's swap proxy) plays Muse's egress and
replaces it with the real token.
"""
import os


def dynamic_credential_entry(name):
    if name != "custom.agent-mailbox":
        raise KeyError(name)
    return {"surrogate": os.environ.get("FAKE_SURROGATE", "hsurr:test-placeholder")}
