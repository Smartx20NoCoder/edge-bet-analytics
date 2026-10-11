// Only retry collection errors. An empty but valid odds response is not an error.
export async function retryGoaloo<T>(request: () => Promise<T>, deadline = Infinity): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); }
    catch (error) {
      if (attempt >= 1 || Date.now() + 20000 >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
}
