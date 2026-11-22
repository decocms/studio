# Verification and troubleshooting

Follow the receiving app’s verification policy and check behavior affected by the change. Type checking establishes compile compatibility; interaction tests check specific behavior; visual review assesses appearance and interaction feel. Report these separately. Small styling edits do not require a full application test suite.

| Symptom | First checks |
| --- | --- |
| Theme is missing | Confirm the app defines and loads the referenced tokens in its active scope |
| Popup has a different font or theme | Inspect the portal container’s DOM variable scope and active mode |
| Theme edits do not reach components | Check competing scopes, hardcoded styles, and stale token mappings |
| A style change affects many controls | Inspect the shared token or component rule and its consumers |
| Font looks different | Confirm the user supplied the licensed font, configured its family and weight, and loaded it successfully |
| Changes vanish on reload | Store the requested change in the app’s token definitions, not only temporary state |
| An API fails type checking | Compare with the receiving app’s installed declarations and actual wrapper props |
| Layout changes when adding borders | Use composed box shadows with native border width zero |

Check relevant modes, interaction states, keyboard behavior, labels, and form values when their wiring changes. Source inspection alone does not establish rendered contrast or visual fidelity.
