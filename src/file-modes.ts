// Permissions for what Moolin writes that others on the machine have no
// business reading: the worlds file holds passwords in plain text, and session
// logs hold everything said to you, in private as well. They are meant for the
// owner alone. (Windows ignores these; its folders are the user's own by default.)
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
