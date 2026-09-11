# Acme Agent SDK

Build an agent in 5 minutes.

## Installation

```bash
pip install acme-agent==1.2.0
```

## Quick Start

Set your key first:

```bash
export ACME_API_KEY=your-key
```

Then run:

```python
from acme_agent import Agent
agent = Agent()
print(agent.run("hello"))
```

You should see:

```
Hello from Acme!
```

## Next steps

Read the [guide](https://docs.acme.example/guide).
