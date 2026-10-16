// Authentication is out of scope for this demo. Everything that touches user
// data takes the user id from here (the server), never from the request body
// or from the model, so swapping in a real session (NextAuth, Clerk, ...) is a
// one-function change.
export async function currentUserId(): Promise<string> {
  return process.env.DEMO_USER_ID || "demo-user";
}
