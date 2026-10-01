# In-page confirmations and input

Application confirmation and text-input decisions use the existing accessible Modal through a Promise-based service. A decision does not execute its action until the user selects Confirm. Cancel, Close, Escape, Back, page departure, or origin unmount resolve as cancellation. Concurrent requests never share an affirmative answer; repeated action clicks are guarded. Input dialogs preserve their default text, distinguish cancellation from an intentionally empty value, and return focus to the trigger, including shadow-DOM update controls.

The standalone update bar requests the same dialog service. If the React app has not loaded, its fallback renders an accessible dialog inside the page; this keeps update recovery available after an asset-loading failure. Update activation and reload remain blocked until the asynchronous decision succeeds, and the waiting worker/state is checked again afterward.

Settings logout uses an awaited `settings-before-leave` request with `waitUntil`, before device revocation or session API writes. A synchronous veto remains supported. Failed logout restores the dirty-state guard. In-app route changes use the router blocker and preserve drafts on cancellation.

Browser-owned security, notification permissions, installation approval, and close/reload `beforeunload` protection remain browser-owned. JavaScript cannot replace those protections with an asynchronous custom modal. The browser may choose its own warning text or suppress the warning; the app does not claim otherwise.

## Manual QA after deployment

- Start a dirty settings/profile edit. Cancel route navigation and Back; verify the draft and URL survive. Confirm, then verify Back/Forward work
- Cancel logout while dirty; verify no subscription/session mutation. Approve logout and induce a failure; verify the dirty guard returns
- Open a second confirmation from a modal. Escape should close only the decision, preserve the underlying editor, and restore focus
- Exercise Cancel, Close, Escape, Back, repeated clicks, and keyboard Tab/Shift+Tab. Verify no action executes before approval
- Open an update confirmation from the topbar. Cancel, retry, then approve; check activation/control precede the single reload
- Verify close-tab/native permission behavior remains genuine browser behavior

## Migrated call sites

- Update confirmation in `public/app-updates.js`
- Unsaved-settings confirmation shared by account/password editors, user administration, route blocking, and logout
- Current-account offline queue/conflict cleanup
- Unowned legacy offline-operation cleanup
- Demo account business-data reset

The destructive cleanup/reset descriptions are preserved verbatim. No backend permission checks or data operations are changed.
