"""BGE-small-zh embedding for Raffaello memory system."""
from chromadb.api.types import EmbeddingFunction, Documents, Embeddings

_model = None

def get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding("BAAI/bge-small-zh-v1.5")
    return _model

class BGEZhEmbedding(EmbeddingFunction):
    def __call__(self, input: Documents) -> Embeddings:
        model = get_model()
        embeddings = list(model.embed(input))
        return [e.tolist() for e in embeddings]

def embed_texts(texts):
    """Convenience function for one-off embedding."""
    model = get_model()
    return [e.tolist() for e in model.embed(texts)]
