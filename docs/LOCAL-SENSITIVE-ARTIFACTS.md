# Local sensitive artifacts

Production database exports, backup archives, environment exports, customer or supplier extracts, payment/accounting extracts, Auth user exports, and private logs must not remain in the repository.

The repository is stored inside OneDrive. Git and Vercel ignore rules do not prevent OneDrive from synchronizing local files, so `tmp/`, `backups/`, `exports/`, and `downloads/` must not be treated as private backup storage.

Safe handling requirements:

- Store production backups only in an approved private location with encryption and restricted access.
- Keep temporary local copies only for the time needed to verify them.
- After verification and after confirming another valid copy exists, delete temporary copies manually.
- Never commit or deploy database exports, backup ZIPs, environment files, credentials, private logs, or customer/payment/accounting extracts.
- Before deleting or moving any existing artifact, confirm its contents, retention requirement, and that it is not the only valid backup.
- Do not place secrets in variables prefixed with `NEXT_PUBLIC_`.

No cleanup is automatic. Existing files must be reviewed and removed only through an explicitly approved operation.
