## Fixed Error: Failed to run sql query: ERROR: 42703: column profiles.role does not exist

```
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS role text DEFAULT 'user'
CHECK (role IN ('admin', 'user'));
```
