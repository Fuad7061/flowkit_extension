FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY agent /app/agent

# Create empty models.json if it doesn't exist (handled by python script if missing but good to have)
# Actually it is copied over in the agent folder

# Set environment variables for the agent
ENV API_HOST=0.0.0.0
ENV API_PORT=8100
ENV PYTHONPATH=/app

# Expose the API and WebSocket port (unified to 8100)
EXPOSE 8100

# Run the FastAPI server
CMD ["python", "-m", "agent.main"]
