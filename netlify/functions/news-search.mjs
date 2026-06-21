import { searchNews } from "../../scripts/news_search.mjs";

export async function handler(event) {
  try {
    const query = event.queryStringParameters?.q || "";
    const payload = await searchNews(query);
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=120",
      },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "News search failed",
      }),
    };
  }
}
