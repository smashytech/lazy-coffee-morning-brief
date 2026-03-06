# Use the official lightweight Node.js image as a base
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package files first — Docker caches this layer separately,
# so npm install only re-runs if dependencies actually changed
COPY package.json package-lock.json* ./

RUN npm install

# Copy the rest of the source code
COPY . .

# Vite's dev server listens on port 5173 by default
EXPOSE 5173

# Start the app, binding to 0.0.0.0 so it's reachable outside the container
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
