// Language-feature polyfills for netstandard2.1 (records / init accessors).

#if !NET5_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit
    {
    }
}
#endif
