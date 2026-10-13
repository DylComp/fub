# Wallet import and signing

**Import keeps your address and funds, but adds another system capable of signing for that wallet.** Understand that change before entering a key. Connecting Phantom, importing a key, verifying ownership and approving automatic trading are different actions.

Fub is independent of Fomo. Knowing a Fomo username or wallet address does not authenticate its owner or grant spending permission.

## What the import flow does

1. You select the public Solana address you intend to use.
2. The browser reads the base58 Solana private key you enter. It derives the public address and refuses a mismatch. Seed phrases are not accepted by this form.
3. If authentication is needed, the browser signs a short-lived wallet-ownership message after checking its origin, address and contents. Privy receives the ownership signature for wallet login; email login is not required by this flow.
4. The browser calls Privy's wallet-import SDK with the key. The SDK handles the encrypted import into Privy's wallet infrastructure. Fub checks that the returned wallet address is the one selected.
5. The form clears the input and temporary references. It saves the public address for reconnecting. Import alone does not add an automatic signer or authorize a trade.

Read the actual implementation: [import UI](src/PrivyImport.tsx), [local key validation and ownership signing](src/wallet-import.ts), [ownership-message checks](src/provider-wallet-auth.ts).

### Where the key is visible

The plaintext key exists in your browser while you enter and import it. It is passed to the Privy SDK. The application does not intentionally send it to a Fub backend endpoint, log it, or save it in browser storage. Public-address storage is different from private-key storage.

This is not a claim that a key never leaves your device: importing it creates signing capability in a separate provider's infrastructure. It is also not a guarantee that JavaScript memory is securely erased. Byte buffers are cleared where supported, but strings, browser internals and SDK behavior prevent a reliable claim of complete memory zeroization.

A compromised device, extension, frontend deployment or dependency could capture a key before encryption. Reviewing source helps identify the intended behavior; it cannot prove that a particular browser session is uncompromised or that a deployed build exactly matches this repository.

## SOL, USDC and cross-chain wallets

Your Fomo Solana address holds SOL and its Solana token accounts, including USDC. There is no separate USDC private key to import. Pay spends that address's Solana USDC and needs SOL for network fees. Solana limit orders and supported SOL copy plans use SOL for buys and applicable fees/rent.

Cross-chain purchases spend Solana USDC from the source wallet. Tokens bought on another chain are delivered to a separately created or linked destination wallet in Fub. Returns go back to USDC in the original Solana wallet. Linking that destination does **not** give Fub control of your existing Fomo EVM wallet, and balances on different networks are not interchangeable.

Source: [managed destination-wallet flow](src/ManagedCashWallet.tsx), [wallet binding](src/cash-wallet-model.ts), [copy scope](src/cash-copy-model.ts).

## Phantom users copying a Fomo trader

A user does not need a Fomo profile to choose a Fomo trader as a leader. Phantom and other supported Solana wallets can connect on Copy trading and Launch.

An extension connection is not permission to sign unattended transactions. The existing automatic-copy pathway requires the same source wallet to be privately imported into Privy, followed by separate background-access and plan approvals. An already imported address can reconnect through Phantom and sign the applicable messages. Pay and limit-order connection flows remain import based.

Read [route restrictions](src/wallet-route-policy.ts), [wallet signing methods](src/useWallet.ts) and [copy activation](src/CashCopyActivation.tsx). A wallet connection must not be described as sufficient for automatic execution.

## What automatic approval authorizes

| Action | What it establishes | What it does not establish |
| --- | --- | --- |
| Public profile lookup | A reported username/address mapping | Ownership or spending permission |
| Wallet ownership signature | Control of the named wallet for a scoped login/binding | A purchase or automatic spending budget |
| Private import | Provider signing capability for the same address | Background trader permission |
| Background access | A configured provider signer/policy relationship | Unlimited plan spending |
| Plan signature | The displayed amounts, networks, slippage, expiry and other scope | Approval for unrelated plans or arbitrary transfers |
| Manual payment/trade confirmation | The reviewed transaction | Future unattended transactions |

The signer service verifies owner/delegation and the configured policy identity, then enforces the applicable plan and transaction checks. Cross-chain copy permissions bind Solana and EVM signatures to the same scope. Budget, signal freshness, inventory and transaction-delivery records are service controls; do not assume every application rule is independently enforced by the provider or on-chain.

The private signing service holds provider credentials and a **signer authorization key**. That is distinct from the imported Solana wallet's private key, but is still a sensitive capability: it can request signatures where provider delegation allows them. Compromise of the service, credentials or provider is a material risk. Separation of processes and policy checks reduces exposure; it does not eliminate trust.

Review: [provider ownership/policy checks](server/privy-owner.ts), [cross-chain ownership checks](server/privy-cash-owner.ts), [signature transport](server/privy-sign-only.ts), [copy permission verification](server/cash-copy-permission.ts), [enrollment](server/cash-copy-enrollment.ts).

## Stop, revoke and recover

- Pause a plan to stop new execution through that plan. Disconnecting the browser is not the same as pausing an active automatic plan.
- Revoke background access using wallet-access controls; review the provider's additional signers as well. An expired or revoked grant must not be treated as an active one.
- A pause or revocation cannot reverse a transaction already signed/submitted, undo a settled trade or cancel an external bridge operation already in progress.
- Check saved attempts before retrying. An uncertain transaction result is not proof that nothing happened.
- If you believe the raw private key was exposed, removing a signer does not invalidate copies of that key. Protect the remaining funds using a secure wallet/device and treat the exposed address accordingly.

See [wallet-access UI](src/SigningPermissions.tsx), [enrollment service](server/signer-enrollment.ts) and [copy journal](server/cash-copy-journal.ts).

## Records and privacy

Wallet addresses and transactions are public on-chain. Fub also stores operational records needed for plans, budgets, positions, delivery and recovery. Pay includes private purchase/receipt data. Do not put gift-card codes, signed login messages, receipt-access links or credentials in public issues.

Production databases, browser sessions, customer receipts, encryption keys and backup recovery material are excluded from this repository. That exclusion is not a claim that operators store no user-related records. Encrypted recovery archives need separately protected recovery keys, restore checks and access controls; losing keys can make an archive unusable, while exposing them can compromise its confidentiality.

No independent security audit is claimed. See [SECURITY.md](SECURITY.md) for reporting and [FEATURE-STATUS.md](FEATURE-STATUS.md) for verification limits.
