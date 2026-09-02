-- Keep this trigger migration LF-only; Cloudflare D1 remote splitting rejects CRLF trigger bodies.
CREATE TRIGGER `users_registration_username_insert_ck`
BEFORE INSERT ON `users`
FOR EACH ROW
WHEN length(NEW.normalized_username) < 3
  OR length(NEW.normalized_username) > 8
  OR NEW.normalized_username <> lower(NEW.normalized_username)
  OR NEW.normalized_username glob '*[^a-z0-9_]*'
BEGIN
  SELECT RAISE(ABORT, 'users registration username must be 3-8 letters, digits, or underscore');
END;
--> statement-breakpoint
CREATE TRIGGER `users_registration_username_update_ck`
BEFORE UPDATE OF normalized_username ON `users`
FOR EACH ROW
WHEN length(NEW.normalized_username) < 3
  OR length(NEW.normalized_username) > 8
  OR NEW.normalized_username <> lower(NEW.normalized_username)
  OR NEW.normalized_username glob '*[^a-z0-9_]*'
BEGIN
  SELECT RAISE(ABORT, 'users registration username must be 3-8 letters, digits, or underscore');
END;
