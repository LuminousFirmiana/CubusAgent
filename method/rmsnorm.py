import torch

t = torch.rsqrt(torch.tensor(4.0))
print(t)

t2 = torch.ones(4, 5)
print(torch.rsqrt(t2))