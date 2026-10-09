# Upstream provenance

The packaged web UI/player is based on the `proudvocab-desktop` renderer in:

- Repository: <https://github.com/melonityhub/proudvocab>
- Source revision: `8dbec172d2305cd45a97ff0f59abdc34fa1342d7`

The Android port adds a Kotlin `ComponentActivity`, an origin-restricted WebView using `WebViewAssetLoader`, Storage Access Framework integration, Android local persistence, phone layouts and CI/release workflows. It also replaces the online licence verifier with a local entitlement provider for this authorized Android build. The desktop source's third-party notices and upstream attribution should be retained when updating the vendored UI.

The upstream GitHub repository did not advertise a repository-level SPDX license at the pinned revision. The code is included here under the authorization confirmed for this task; do not infer a general redistribution license from the fact that a repository is public. Before public redistribution beyond that authorization, the maintainer should record the applicable rights and notices explicitly.
