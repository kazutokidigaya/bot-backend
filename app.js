const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const Groq = require("groq-sdk");

dotenv.config();

const app = express();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

app.use(cors());
app.use(express.json());

// Function to generate ideas
async function generateIdeas(prompt) {
  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are an expert in generating creative and actionable ideas.",
        },
        {
          role: "user",
          content: `${prompt}\nGenerate 3 unique, short, and actionable ideas. Provide them as a numbered list without introductory or concluding statements.`,
        },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 150,
    });

    console.log(response.choices[0].message.content);
    const ideas = response.choices[0].message.content
      .split("\n")
      .map((idea) => idea.trim())
      .filter((idea) => idea);

    console.log(ideas);
    if (ideas.length === 0) {
      return { error: "No ideas generated." };
    }

    return ideas.map((idea, index) => ({ id: index + 1, text: idea }));
  } catch (error) {
    console.error("Error generating ideas:", error.message);
    return { error: "Failed to generate ideas." };
  }
}

// repair and parse JSON
async function rankIdeasWithGroq(query, ideas) {
  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `
              You are an AI assistant ranking ideas based on relevance, potential impact, and feasibility. 
              Respond with a valid JSON array where each object has the following structure:
              {
                "id": <number>,
                "relevance": <1-5>,
                "impact": <1-5>,
                "feasibility": <1-5>,
                "reason": "<justification>"
              }
              Ensure the JSON is valid, complete, and includes all required fields.
            `,
        },
        {
          role: "user",
          content: `Query: ${query}\nIdeas: ${JSON.stringify(
            ideas.map((idea) => idea.text)
          )}\nRank these ideas.`,
        },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 500,
    });

    const rawContent = response.choices[0].message.content.trim();

    // parse the JSON response
    let rankedIdeas;
    try {
      rankedIdeas = JSON.parse(rawContent);
    } catch (error) {
      console.warn("Failed to parse full JSON. Extracting valid parts...");
      rankedIdeas = extractValidJSON(rawContent); // valid extraction
    }

    // Merge the ranked data with the original ideas
    return rankedIdeas.map((ranking, index) => ({
      ...ideas[index],
      ...ranking,
      score: ranking.relevance + ranking.impact + ranking.feasibility,
    }));
  } catch (error) {
    console.error("Error ranking ideas:", error.message);

    // default ranking if everything fails
    return ideas.map((idea) => ({
      ...idea,
      relevance: 3,
      impact: 3,
      feasibility: 3,
      score: 9,
    }));
  }
}

//extract usable parts of malformed JSON
function extractValidJSON(rawContent) {
  const matches = rawContent.match(/\{[^}]+\}/g); // Match individual JSON objects
  if (!matches) {
    throw new Error("No valid JSON objects found in response.");
  }

  return matches
    .map((jsonString, index) => {
      try {
        const parsed = JSON.parse(jsonString);
        if (
          parsed.id &&
          parsed.relevance &&
          parsed.impact &&
          parsed.feasibility
        ) {
          return parsed; // Return valid object
        }
        console.warn(`Skipping incomplete object at index ${index}`);
        return null; // Skip invalid objects
      } catch (error) {
        console.warn(
          `Failed to parse object at index ${index}:`,
          error.message
        );
        return null;
      }
    })
    .filter(Boolean); // Remove null entries
}

// Generate and rank ideas endpoint
app.post("/generate", async (req, res) => {
  const { query } = req.body;

  if (!query) return res.status(400).json({ error: "Query is required." });

  const ideas = await generateIdeas(query);
  if (ideas.error) return res.status(500).json({ error: ideas.error });

  const rankedIdeas = await rankIdeasWithGroq(query, ideas);
  res.json(rankedIdeas.sort((a, b) => b.score - a.score));
});

// Provide detailed suggestions
app.post("/suggest", async (req, res) => {
  const { selectedIdeas } = req.body;

  if (!selectedIdeas || selectedIdeas.length !== 2) {
    return res
      .status(400)
      .json({ error: "Exactly two ideas must be selected." });
  }

  try {
    const suggestions = await Promise.all(
      selectedIdeas.map(async (idea) => {
        const response = await groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content:
                "You are an assistant that provides detailed suggestions for implementing ideas, breaking them into Key Features and Actionable Suggestions. Limit to 3 points for each.",
            },
            {
              role: "user",
              content: `Provide a detailed breakdown for the idea: ${idea.text}. Include an overview, key features, and actionable suggestions.`,
            },
          ],
          model: "llama-3.3-70b-versatile",
          temperature: 0.7,
          max_tokens: 300,
        });

        const content = response.choices[0].message.content.trim();
        const suggestionsArray = content.split("\n").map((line) => line.trim());
        console.log({
          suggestionsArray,
        });
        return {
          id: idea.id,
          title: idea.text,
          overview: suggestionsArray[1] || "No overview provided.",
          suggestions: suggestionsArray.slice(1),
        };
      })
    );

    res.json(suggestions);
  } catch (error) {
    console.error("Error generating suggestions:", error.message);
    res.status(500).json({ error: "Failed to generate suggestions." });
  }
});

app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.headers["x-forwarded-proto"] !== "https"
  ) {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
});

app.get("/", (req, res) => {
  res.status(200).json({ message: "Backend is up and running!" });
});

// Start the server
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 5000;
  const HOST = "0.0.0.0"; // Bind to all interfaces for Render
  const server = app.listen(PORT, HOST, () =>
    console.log(`Server is running on port ${PORT}`)
  );

  // Set custom timeouts to avoid Render connection resets
  server.keepAliveTimeout = 120000; // 2 minutes
  server.headersTimeout = 120000; // 2 minutes
}
