//go:build linux

package report

import "syscall"

func readDiskStats(path string) map[string]any {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return map[string]any{}
	}

	blockSize := uint64(stat.Bsize)
	total := stat.Blocks * blockSize
	free := stat.Bfree * blockSize
	if total == 0 || free > total {
		return map[string]any{}
	}

	used := total - free
	return map[string]any{
		"diskMountpoint":     path,
		"diskTotalBytes":     total,
		"diskUsedBytes":      used,
		"diskAvailableBytes": stat.Bavail * blockSize,
		"diskUsagePercent":   roundPercent(float64(used) / float64(total) * 100),
	}
}
